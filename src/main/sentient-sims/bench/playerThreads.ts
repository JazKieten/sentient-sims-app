import log from 'electron-log';
import { ApiContext } from '../services/ApiContext';
import { PlayerConversationService } from '../services/PlayerConversationService';
import {
  buildAskSentientSim,
  buildTwitchAskEvent,
  TWITCH_CHAT_HEARD_AS,
  TWITCH_CHAT_SPEAKER,
  twitchChatFlavor,
} from '../util/twitchSimTarget';
import { countEvasive, PlayerThreadFixture } from './playerThreadFixtures';

// Replays one fixture conversation through the player-facing reply path — the same
// runDirectedGeneration call the chat window, the voice and Twitch make — against the
// loaded save, and reports what the sim said, when the thread closed, how evasive the
// replies were, and what the sim would have done about it. Nothing is stored (saveMemory
// off) and nothing is dispatched (suggestActionsOnly): a bench run leaves the save as it
// found it.

export type PlayerThreadTurn = {
  playerLine: string;
  reply: string;
  // The thread after this turn: 'open', 'closed:<reason>', or 'none' when no thread exists
  thread: string;
  exchangeIds: number[];
};

export type PlayerThreadRun = {
  fixture: Pick<PlayerThreadFixture, 'id' | 'title' | 'speaker' | 'simName' | 'target'>;
  simId: string;
  speaker: string;
  turns: PlayerThreadTurn[];
  // Which turn (1-based) the sim closed the conversation on, or null if it never did
  closedAt: number | null;
  evasiveHits: Record<string, number>;
  actions: { turn: number; simId: string; acted: boolean; action?: string; target?: string }[];
};

// A follow-through action is three model calls after the reply returns; the bench waits
// for the verdicts before reporting, but never forever
const ACTION_SETTLE_MS = 5_000;
const ACTION_WAIT_MAX_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function runPlayerThread(
  ctx: ApiContext,
  fixture: PlayerThreadFixture,
  simId: string,
  // Ad-hoc lines in place of the fixture's, for driving a particular turn (a wrap-up)
  linesOverride?: string[],
): Promise<PlayerThreadRun> {
  const lines = linesOverride && linesOverride.length > 0 ? linesOverride : fixture.lines;
  let description: string | undefined;
  try {
    description = ctx.participantRepository.getParticipant({ id: simId, fullName: fixture.simName }).description;
  } catch {
    // no save loaded, or an unknown sim: the name and the state report still carry the scene
  }
  const entry = ctx.simStateCache.getSim(simId);
  const sim = buildAskSentientSim({ simId, name: fixture.simName, description, isActive: entry?.is_active });
  const isChat = fixture.speaker === 'Chat';
  // Chat lines name a viewer the way TwitchChatService does, sharing one "Chat" thread
  const threadSpeaker = isChat ? TWITCH_CHAT_SPEAKER : ctx.settings.playerSpeakerName;
  const speaker = isChat ? `${TWITCH_CHAT_SPEAKER} (viewer)` : threadSpeaker;

  // A clean thread every run, so a replay does not resume the last one
  ctx.playerConversations.closeAll('reset');
  const key = PlayerConversationService.keyFor([simId], threadSpeaker);

  const turns: PlayerThreadTurn[] = [];
  const actions: PlayerThreadRun['actions'] = [];
  let closedAt: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    // Read per turn: a real game event between turns can move the current scene, and a
    // bench event at a stale location would read as a scene boundary that closes every
    // thread (seen on the first live run, 2026-09-21)
    const locationId = ctx.sceneService.getCurrentScene()?.locationId ?? 0;
    const event = buildTwitchAskEvent(sim, text, locationId);
    const before = ctx.aiExchangeLog.list(1).at(0)?.id ?? 0;
    const turnNumber = index + 1;
    // Sequential on purpose: it is a conversation

    const result = await ctx.ai.runDirectedGeneration(
      event,
      {
        playerLine: { speaker, text },
        playerLineFlavor: isChat ? twitchChatFlavor('viewer') : undefined,
        playerLineHeardAs: isChat ? TWITCH_CHAT_HEARD_AS : undefined,
        playerLineThreadSpeaker: threadSpeaker,
        saveMemory: false,
        suggestActionsOnly: true,
        onConversationAction: (verdict) => {
          actions.push({ turn: turnNumber, ...verdict });
        },
      },
      { priority: true },
    );
    const exchangeIds = ctx.aiExchangeLog
      .list(30)
      .map((exchange) => exchange.id)
      .filter((id) => id > before)
      .sort((a, b) => a - b);
    const thread = ctx.playerConversations.get(key);
    let state = 'none';
    if (thread && !thread.closed) {
      state = 'open';
    } else if (thread?.closed) {
      state = `closed:${thread.closedReason ?? 'unknown'}`;
    }
    turns.push({ playerLine: text, reply: (result.text ?? '').trim(), thread: state, exchangeIds });
    if (state.startsWith('closed') && closedAt === null) {
      closedAt = turnNumber;
    }
  }

  // Let the follow-through verdicts land
  const startedWaiting = Date.now();
  let seen = actions.length;
  let quietSince = Date.now();
  while (Date.now() - startedWaiting < ACTION_WAIT_MAX_MS && Date.now() - quietSince < ACTION_SETTLE_MS) {
    await sleep(500);
    if (actions.length !== seen) {
      seen = actions.length;
      quietSince = Date.now();
    }
  }

  const run: PlayerThreadRun = {
    fixture: {
      id: fixture.id,
      title: fixture.title,
      speaker: fixture.speaker,
      simName: fixture.simName,
      target: fixture.target,
    },
    simId,
    speaker,
    turns,
    closedAt,
    evasiveHits: countEvasive(turns.map((turn) => turn.reply)),
    actions,
  };
  log.info(
    `[Bench] player thread ${fixture.id} for ${fixture.simName}: ${turns.length} turn(s), ` +
      `closed ${closedAt === null ? 'never' : `on turn ${closedAt}`}, evasive ${JSON.stringify(run.evasiveHits)}, ` +
      `${actions.length} action verdict(s)`,
  );
  return run;
}
