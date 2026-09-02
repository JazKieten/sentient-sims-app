import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { ApiType } from 'main/sentient-sims/models/ApiType';
import { AIActionType } from 'main/sentient-sims/models/AIActionType';
import { OpenAICompatibleRequest } from 'main/sentient-sims/models/OpenAICompatibleRequest';
import { ApiContext } from 'main/sentient-sims/services/ApiContext';
import { OpenAIService } from 'main/sentient-sims/services/OpenAIService';
import { StageId } from 'main/sentient-sims/pipeline/stages';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { mockApiContext } from './util';

// The registry is only worth having if a stage id actually reaches the provider seam and a
// player's override actually replaces that stage's system prompt. These drive runOneShot
// end to end with the provider itself stubbed.
describe('stage prompt routing', () => {
  let ctx: ApiContext;
  let sent: OpenAICompatibleRequest[];

  beforeEach(() => {
    ctx = mockApiContext();
    fs.mkdirSync(ctx.directory.getSentientSimsFolder(), { recursive: true });
    ctx.settings.aiApiType = ApiType.OpenAI;
    ctx.settings.openaiKey = 'sk-test';
    sent = [];
    vi.spyOn(OpenAIService.prototype, 'sentientSimsGenerate').mockImplementation((request: OpenAICompatibleRequest) => {
      sent.push(request);
      return Promise.resolve({ text: 'ok', request });
    });
  });

  function systemPromptSent(): string {
    return sent[0].messages.find((message) => message.role === 'system')?.content ?? '';
  }

  it('sends the built prompt when the stage has no override', async () => {
    await ctx.ai.runOneShot(
      'Cognition Monologue: Alice',
      'the built prompt',
      'her situation',
      120,
      undefined,
      AIActionType.COGNITION,
      undefined,
      {
        stageId: StageId.DEFAULT_MODE_MONOLOGUE,
      },
    );

    expect(systemPromptSent()).toBe('the built prompt');
  });

  it('sends the override in place of the built prompt for that stage', async () => {
    ctx.settings.stagePromptOverrides = { [StageId.DEFAULT_MODE_MONOLOGUE]: 'think like a pirate' };

    await ctx.ai.runOneShot(
      'Cognition Monologue: Alice',
      'the built prompt',
      'her situation',
      120,
      undefined,
      AIActionType.COGNITION,
      undefined,
      {
        stageId: StageId.DEFAULT_MODE_MONOLOGUE,
      },
    );

    expect(systemPromptSent()).toBe('think like a pirate');
  });

  it('leaves other stages alone when one stage is overridden', async () => {
    ctx.settings.stagePromptOverrides = { [StageId.DEFAULT_MODE_MONOLOGUE]: 'think like a pirate' };

    await ctx.ai.runOneShot(
      'Cognition Scores: Alice',
      'the scoring prompt',
      'her situation',
      120,
      undefined,
      AIActionType.COGNITION,
      undefined,
      {
        stageId: StageId.LIMBIC_SALIENCE,
      },
    );

    expect(systemPromptSent()).toBe('the scoring prompt');
  });

  it('ignores an override on a call that names no stage', async () => {
    ctx.settings.stagePromptOverrides = { [StageId.DEFAULT_MODE_MONOLOGUE]: 'think like a pirate' };

    await ctx.ai.runOneShot('Chat', 'the built prompt', 'input', 120);

    expect(systemPromptSent()).toBe('the built prompt');
  });

  it('keeps a blank override out of the request', async () => {
    // Written straight into the store, bypassing the setter's sanitizer, to prove the
    // read path refuses it too — an empty system prompt would silently gut the stage.
    ctx.settings.set(SettingsEnum.STAGE_PROMPT_OVERRIDES, { [StageId.DEFAULT_MODE_MONOLOGUE]: '   ' });

    await ctx.ai.runOneShot(
      'Cognition Monologue: Alice',
      'the built prompt',
      'her situation',
      120,
      undefined,
      AIActionType.COGNITION,
      undefined,
      {
        stageId: StageId.DEFAULT_MODE_MONOLOGUE,
      },
    );

    expect(systemPromptSent()).toBe('the built prompt');
  });
});
