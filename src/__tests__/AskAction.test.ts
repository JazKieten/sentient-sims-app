import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiType } from 'main/sentient-sims/models/ApiType';
import { ChatInteractionEvent, SSEventType } from 'main/sentient-sims/models/InteractionEvents';
import { InteractionEventStatus } from 'main/sentient-sims/models/InteractionEventResult';
import { OpenAICompatibleRequest } from 'main/sentient-sims/models/OpenAICompatibleRequest';
import { PromptRequest } from 'main/sentient-sims/models/OpenAIRequestBuilder';
import { SentientSim } from 'main/sentient-sims/models/SentientSim';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { SimAge } from 'main/sentient-sims/models/SimAge';
import { SimStateReport } from 'main/sentient-sims/models/SimStateReport';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { ASK_ACTION_SOURCE } from 'main/sentient-sims/services/AskActionService';
import { firstJsonBlock, firstJsonBlockLoose } from 'main/sentient-sims/util/jsonBlock';
import { mockApiContext } from './util';
import { autonomyOf } from 'main/sentient-sims/tiers/autonomy';

// The ask-action sub-type: a solo Voice/Twitch line triaged as a request to DO something
// matches the sim's full offered vocabulary, the sim answers yes-or-no in character, and
// the "why" airs as their out-loud thought. Every miss falls through to the ordinary
// directed voice reply — these tests pin both halves.

const askedSim: SentientSim = {
  careers: [],
  name: 'Marisol Vega',
  age: SimAge.ADULT,
  sim_id: '882730689256095860',
  gender: 'Female',
  traits: ['trait_Cheerful'],
  moods: ['Mood_Playful'],
  is_ghost: false,
  grubby: false,
  in_pool: false,
  is_at_home: false,
  is_dying: false,
  is_human: true,
  is_inside_building: true,
  is_outside: false,
  is_pet: false,
  on_fire: false,
  on_home_lot: false,
  sleeping: false,
  is_pregnant: false,
  is_player_sim: true,
};

function buildSoloChatEvent(action: string): ChatInteractionEvent {
  return {
    event_id: crypto.randomUUID(),
    event_type: SSEventType.CHAT,
    location_id: 0,
    sentient_sims: [askedSim],
    action,
    relationships: { relationship_bits: [] },
    environment: {
      location_id: 90336000,
      world_id: 0,
      time: { second: 0, minute: 0, hour: 14, day: 2, week: 1 },
    },
  };
}

function stateReport(): SimStateReport {
  return {
    type: 'state_report',
    seq: 1,
    lot: { action_keys: ['jog'] },
    sims: [
      {
        sim_id: askedSim.sim_id,
        objects: [{ object_id: '777', action_keys: ['read_book'] }],
        sims: [],
        is_household: true,
        is_active: true,
      },
    ],
  } as unknown as SimStateReport;
}

const briefing = `=== SCENE ===
A quiet living room, midday.
=== PROMPT FOR Marisol Vega ===
You are playing Marisol Vega. Answer warmly.`;

const actorLine = 'SAY: I was just thinking the same thing.';

describe('Ask actions', () => {
  let ctx: ApiContext;
  let triageOutput: string;
  let matchOutput: string;
  let decisionOutput: string;

  function mockGeneration() {
    const service = ctx.getGenerationService(ApiType.OpenAI);
    return vi.spyOn(service, 'sentientSimsGenerate').mockImplementation((request: OpenAICompatibleRequest) => {
      const systemPrompt = request.messages.find((message) => message.role === 'system')?.content ?? '';
      let text = actorLine;
      if (systemPrompt.includes('You triage one line')) {
        text = triageOutput;
      } else if (systemPrompt.includes('You match a request')) {
        text = matchOutput;
      } else if (systemPrompt.includes('just asked you to do something')) {
        text = decisionOutput;
      } else if (systemPrompt.includes('You are directing a scene')) {
        text = briefing;
      } else if (systemPrompt.includes('You are the director of a show')) {
        text = `Marisol Vega: I was just thinking the same thing.`;
      } else if (systemPrompt.includes('You are scoring the scene')) {
        text = '{"Marisol Vega": {"memory": 3, "action": 2, "action_reason": "Content."}}';
      }
      return Promise.resolve({ text, request });
    });
  }

  beforeEach(() => {
    ctx = mockApiContext();
    // No sqlite in this suite: the prompt builder (the only unguarded DB toucher on
    // these paths) is stubbed, and the repository calls under test are spied directly
    const promptRequest: PromptRequest = {
      location: '<LOCATION>A quiet living room.</LOCATION>',
      dateTime: 'It is midday.',
      season: '',
      participants: 'Marisol Vega is a cheerful adult.',
      systemPrompt: '',
      memories: [],
      maxResponseTokens: 200,
      maxTokens: 3900,
    };
    vi.spyOn(ctx.promptBuilder, 'buildPromptRequest').mockResolvedValue(promptRequest);
    ctx.settings.aiApiType = ApiType.OpenAI;
    ctx.settings.openaiKey = 'sk-test';
    ctx.simStateCache.ingest(stateReport());
    triageOutput = '{"intent": "do"}';
    matchOutput = '{"action": "read_book", "target_object_id": "777", "label": "read a book", "confidence": 0.9}';
    decisionOutput = '{"willing": true, "thought": "A book sounds perfect right now."}';
  });

  it('dispatches a matched action when the sim says yes, and airs the why as a thought', async () => {
    mockGeneration();
    const dispatch = vi.spyOn(autonomyOf(ctx).actionDispatcher, 'dispatch').mockReturnValue('rid-1');

    const result = await ctx.ai.interactionEvent(buildSoloChatEvent('go read a book'));

    expect(result.status).toEqual(InteractionEventStatus.GENERATED);
    expect(result.exchanges?.map((exchange) => exchange.label)).toEqual([
      'Ask Triage',
      'Ask Match: Marisol Vega',
      'Ask Decision: Marisol Vega',
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sim_id: askedSim.sim_id,
        action: 'read_book',
        target_object_id: '777',
        priority: 'critical',
        // An accepted ask replaces the sim's current plan: the mod cancels their
        // queued and running interactions before pushing
        preempt: true,
        source: ASK_ACTION_SOURCE,
        motivation: 'The Voice asked: "go read a book"',
      }),
    );
    expect(result.text).toContain('A book sounds perfect right now.');
    expect(result.memory?.content).toEqual('Marisol Vega (to self): A book sounds perfect right now.');
    expect(result.memory?.event_type).toEqual('monologue');
    // The ask heads the memory row, attributed like any chat beat
    expect(result.memory?.action).toEqual('The Voice: go read a book');
  });

  it('airs an in-character refusal without dispatching anything', async () => {
    decisionOutput = '{"willing": false, "thought": "No. I am exhausted and the book can wait."}';
    mockGeneration();
    const dispatch = vi.spyOn(autonomyOf(ctx).actionDispatcher, 'dispatch').mockReturnValue('rid-1');

    const result = await ctx.ai.interactionEvent(buildSoloChatEvent('go read a book'));

    expect(result.status).toEqual(InteractionEventStatus.GENERATED);
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.memory?.content).toContain('the book can wait');
  });

  it('falls through to the ordinary voice reply when triage says talk', async () => {
    triageOutput = '{"intent": "talk"}';
    mockGeneration();
    const dispatch = vi.spyOn(autonomyOf(ctx).actionDispatcher, 'dispatch').mockReturnValue('rid-1');

    const result = await ctx.ai.interactionEvent(buildSoloChatEvent('how are you feeling today?'));

    expect(result.status).toEqual(InteractionEventStatus.GENERATED);
    expect(result.exchanges?.map((exchange) => exchange.label)).toContain('Director Briefing');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('falls through when nothing offered matches the request', async () => {
    matchOutput = '{"action": null, "confidence": 0}';
    mockGeneration();
    const dispatch = vi.spyOn(autonomyOf(ctx).actionDispatcher, 'dispatch').mockReturnValue('rid-1');

    const result = await ctx.ai.interactionEvent(buildSoloChatEvent('go fly to the moon'));

    expect(result.exchanges?.map((exchange) => exchange.label)).toContain('Director Briefing');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('falls through when a matched action fails the mechanical intent gate', async () => {
    // 'dance' is a real whitelist verb, but this snapshot offers no provider for it
    matchOutput = '{"action": "dance", "confidence": 0.8}';
    mockGeneration();
    const dispatch = vi.spyOn(autonomyOf(ctx).actionDispatcher, 'dispatch').mockReturnValue('rid-1');

    const result = await ctx.ai.interactionEvent(buildSoloChatEvent('go dance'));

    expect(result.exchanges?.map((exchange) => exchange.label)).toContain('Director Briefing');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('skips even the triage call when the sim has no state report', async () => {
    ctx.simStateCache.reset();
    const generate = mockGeneration();

    await ctx.ai.interactionEvent(buildSoloChatEvent('go read a book'));

    const systemPrompts = generate.mock.calls.map(
      ([request]) => request.messages.find((message) => message.role === 'system')?.content ?? '',
    );
    expect(systemPrompts.some((prompt) => prompt.includes('You triage one line'))).toBe(false);
    expect(systemPrompts.some((prompt) => prompt.includes('You are directing a scene'))).toBe(true);
  });

  it('is inert when askActionsEnabled is off', async () => {
    ctx.settings.set(SettingsEnum.ASK_ACTIONS_ENABLED, false);
    const generate = mockGeneration();

    await ctx.ai.interactionEvent(buildSoloChatEvent('go read a book'));

    const systemPrompts = generate.mock.calls.map(
      ([request]) => request.messages.find((message) => message.role === 'system')?.content ?? '',
    );
    expect(systemPrompts.some((prompt) => prompt.includes('You triage one line'))).toBe(false);
  });

  it('persists the Twitch shape itself, credited to the asking viewer', async () => {
    mockGeneration();
    vi.spyOn(autonomyOf(ctx).actionDispatcher, 'dispatch').mockReturnValue('rid-1');
    vi.spyOn(ctx.participantRepository, 'getParticipants').mockReturnValue([
      { id: askedSim.sim_id, name: askedSim.name },
    ]);
    const createMemory = vi.spyOn(ctx.memoryRepository, 'createMemory').mockReturnValue(undefined);

    const result = await ctx.ai.runDirectedGeneration(
      buildSoloChatEvent('go read a book'),
      {
        playerLine: { speaker: 'Chat', text: 'go read a book' },
        playerLineFlavor: 'a friendly, curious crowd watching their life that only they can hear',
        playerLineDisplaySpeaker: 'Chat (viewer)',
        saveMemory: true,
      },
      { priority: true },
    );

    expect(result.status).toEqual(InteractionEventStatus.GENERATED);
    expect(createMemory).toHaveBeenCalledTimes(1);
    const [request, opts] = createMemory.mock.calls[0];
    expect(request.memory.event_type).toEqual('monologue');
    expect(request.memory.action).toEqual('Chat: go read a book');
    expect(request.index?.owner).toEqual(askedSim.sim_id);
    expect(opts?.modDisplayAction).toEqual('Chat (viewer): go read a book');
  });

  // The chat voice narrating the question is the whole reason a viewer's ask reads as a
  // viewer's ask on stream. It airs on the ordinary talk path; before this it went silent
  // the moment triage said "do", so the same question was narrated or not depending on
  // which pipeline it happened to take.
  it('narrates the Twitch question in the chat voice on the ask-action path too', async () => {
    mockGeneration();
    vi.spyOn(autonomyOf(ctx).actionDispatcher, 'dispatch').mockReturnValue('rid-1');
    const playTtsLines = vi.spyOn(ctx.ai, 'playTtsLines').mockReturnValue(undefined);

    await ctx.ai.runDirectedGeneration(
      buildSoloChatEvent('go read a book'),
      {
        playerLine: { speaker: 'Chat', text: 'go read a book' },
        playerLineDisplaySpeaker: 'Chat (viewer)',
        speakPlayerLine: { voiceId: 'voice-123', spokenText: 'viewer asks: go read a book' },
      },
      { priority: true },
    );

    expect(playTtsLines).toHaveBeenCalledTimes(1);
    const [lines] = playTtsLines.mock.calls[0];
    expect(lines).toEqual([
      {
        speaker: 'Chat (viewer)',
        text: 'viewer asks: go read a book',
        voiceId: 'voice-123',
        // The subtitle went out via sendSceneLineToMod above; the renderer must not
        // report this line again when it starts playing
        skipSceneLine: true,
      },
      { speaker: 'Marisol Vega (to self)', text: 'A book sounds perfect right now.' },
    ]);
  });

  it("leaves the Voice's own ask unvoiced — the player already said it", async () => {
    mockGeneration();
    vi.spyOn(autonomyOf(ctx).actionDispatcher, 'dispatch').mockReturnValue('rid-1');
    const playTtsLines = vi.spyOn(ctx.ai, 'playTtsLines').mockReturnValue(undefined);

    await ctx.ai.interactionEvent(buildSoloChatEvent('go read a book'));

    const [lines] = playTtsLines.mock.calls[0];
    expect(lines).toEqual([{ speaker: 'Marisol Vega (to self)', text: 'A book sounds perfect right now.' }]);
  });

  // Live 2026-08-27: llama-3.3-70b answered this stage with the prose unquoted almost
  // every time, a strict parse threw, and 21 of 22 matched asks died here without a word
  // in the log — the player heard an ordinary talk reply while the sim had said yes
  it('dispatches when the decision comes back with the thought unquoted', async () => {
    decisionOutput =
      '{"willing": true, "thought": I need to get ready for the day anyway and brushing my teeth is a good place to start, might as well get it out of the way}';
    mockGeneration();
    const dispatch = vi.spyOn(autonomyOf(ctx).actionDispatcher, 'dispatch').mockReturnValue('rid-1');

    const result = await ctx.ai.interactionEvent(buildSoloChatEvent('go read a book'));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: 'read_book', preempt: true }));
    expect(result.memory?.content).toEqual(
      'Marisol Vega (to self): I need to get ready for the day anyway and brushing my teeth is a good place to start, might as well get it out of the way',
    );
  });

  it('airs an unquoted refusal without dispatching anything', async () => {
    decisionOutput =
      '{"willing": false, "thought": I\'m not really in the mood for games, and I don\'t feel like being told what to do right now}';
    mockGeneration();
    const dispatch = vi.spyOn(autonomyOf(ctx).actionDispatcher, 'dispatch').mockReturnValue('rid-1');

    const result = await ctx.ai.interactionEvent(buildSoloChatEvent('go read a book'));

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.memory?.content).toContain("I'm not really in the mood for games");
  });

  it('matches when the label comes back unquoted', async () => {
    matchOutput = '{"action": "read_book", "target_object_id": "777", "label": read a book, "confidence": 0.9}';
    mockGeneration();
    const dispatch = vi.spyOn(autonomyOf(ctx).actionDispatcher, 'dispatch').mockReturnValue('rid-1');

    await ctx.ai.interactionEvent(buildSoloChatEvent('go read a book'));

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: 'read_book' }));
  });

  it('falls through to the ordinary voice reply when the decision is unrepairable', async () => {
    decisionOutput = 'Sure, why not!';
    mockGeneration();
    const dispatch = vi.spyOn(autonomyOf(ctx).actionDispatcher, 'dispatch').mockReturnValue('rid-1');

    const result = await ctx.ai.interactionEvent(buildSoloChatEvent('go read a book'));

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.exchanges?.map((exchange) => exchange.label)).toContain('Director Briefing');
  });
});

describe('firstJsonBlockLoose', () => {
  it('quotes a bare prose value, commas and apostrophes intact', () => {
    expect(
      firstJsonBlockLoose('{"willing": false, "thought": I\'m exhausted, and rest, not jogging, is what I want}'),
    ).toEqual({ willing: false, thought: "I'm exhausted, and rest, not jogging, is what I want" });
  });

  it('repairs a bare value that is not the last key', () => {
    expect(firstJsonBlockLoose('{"thought": I would rather not, honestly, "willing": false}')).toEqual({
      thought: 'I would rather not, honestly',
      willing: false,
    });
  });

  it('leaves well-formed JSON exactly as strict parsing found it', () => {
    const raw = '{"action": null, "confidence": 0, "label": "read a book"}';
    expect(firstJsonBlockLoose(raw)).toEqual(firstJsonBlock(raw));
    expect(firstJsonBlockLoose('{"willing": true, "thought": "Quoted, with a comma."}')).toEqual({
      willing: true,
      thought: 'Quoted, with a comma.',
    });
  });

  it('keeps real scalars typed rather than stringifying them', () => {
    expect(firstJsonBlockLoose('{"confidence": 0.8, "willing": true, "note": plain words}')).toEqual({
      confidence: 0.8,
      willing: true,
      note: 'plain words',
    });
  });

  it('stays a miss when there is nothing to repair', () => {
    expect(firstJsonBlockLoose('Sure, why not!')).toBeUndefined();
    expect(firstJsonBlockLoose('{"willing": true, "thought": [unclosed}')).toBeUndefined();
  });
});
