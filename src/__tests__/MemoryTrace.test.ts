import { MemoryTraceService } from 'main/sentient-sims/services/MemoryTraceService';
import { MemoryTrace } from 'main/sentient-sims/models/MemoryTrace';
import { diffLines, diffWords, hasChanges } from 'main/sentient-sims/util/textDiff';

function trace(direction: string): MemoryTrace {
  return { pipeline: 'directed_scene', exchanges: [], directorDirection: direction };
}

describe('MemoryTraceService', () => {
  it('attaches a pending trace to the memory row created from its text', () => {
    const service = new MemoryTraceService();
    service.recordPending(['Alice: Hey.\nBob: Hey yourself.'], trace('scene one'));

    service.attach({ id: 7, content: 'Alice: Hey.\nBob: Hey yourself.', location_id: 1 });

    expect(service.getTrace('7')?.directorDirection).toBe('scene one');
  });

  it('matches the chat-window formatting the mod posts back', () => {
    const service = new MemoryTraceService();
    service.recordPending(['Alice: Hey.\nBob: Hey yourself.'], trace('scene one'));

    // formatSceneForChatWindow double-spaces lines, and the mod prefixes a newline
    service.attach({ id: 9, content: '\nAlice: Hey.\n\nBob: Hey yourself.', location_id: 1 });

    expect(service.getTrace('9')?.directorDirection).toBe('scene one');
  });

  it('claims the newest matching trace and only claims it once', () => {
    const service = new MemoryTraceService();
    service.recordPending(['Same line.'], trace('older'));
    service.recordPending(['Same line.'], trace('newer'));

    service.attach({ id: 1, content: 'Same line.', location_id: 1 });
    service.attach({ id: 2, content: 'Same line.', location_id: 1 });

    expect(service.getTrace('1')?.directorDirection).toBe('newer');
    expect(service.getTrace('2')?.directorDirection).toBe('older');
  });

  it('ignores memories with no id or no content', () => {
    const service = new MemoryTraceService();
    service.recordPending(['Alice: Hey.'], trace('scene one'));

    service.attach({ content: 'Alice: Hey.', location_id: 1 });
    service.attach({ id: 3, location_id: 1 });

    expect(service.getTrace('3')).toBeUndefined();
    // The trace is still pending, so the real row can still claim it
    service.attach({ id: 4, content: 'Alice: Hey.', location_id: 1 });
    expect(service.getTrace('4')?.directorDirection).toBe('scene one');
  });
});

describe('textDiff', () => {
  it('reports no changes when the reviewer passed the lines through', () => {
    const diff = diffLines('Alice: Hey.\nBob: Hi.', 'Alice: Hey.\n\nBob: Hi.');
    expect(hasChanges(diff)).toBe(false);
  });

  it('marks a rewritten line as a removed/added pair with word detail', () => {
    const diff = diffLines('Alice: Hey there pal.\nBob: Hi.', 'Alice: Hey there friend.\nBob: Hi.');

    expect(diff.map((line) => line.op)).toEqual(['removed', 'added', 'equal']);
    const addedWords = diff[1].words?.filter((part) => part.op === 'added').map((part) => part.text.trim());
    expect(addedWords).toEqual(['friend.']);
  });

  it('marks dropped and inserted lines', () => {
    const diff = diffLines('Alice: Hey.\nBob: Hi.\nAlice: Bye.', 'Alice: Hey.\nBob: Hi.');
    expect(diff[2]).toMatchObject({ op: 'removed', text: 'Alice: Bye.' });
  });

  it('treats punctuation and case differences as unchanged words', () => {
    const parts = diffWords('Sure, okay', 'sure okay');
    expect(parts.every((part) => part.op === 'equal')).toBe(true);
  });
});
