import { FileMover, signWithStrayFilesAside, strayFileNamedBy } from 'main/sentient-sims/services/GameSigningService';

const CONTENTS = '/Applications/EA Games/The Sims 4.app/Contents';

// What codesign printed on the 2026-10-29 Mac ticket.
const strayError = (file: string) =>
  new Error(
    `Command failed: codesign --force --sign - ...\n` +
      `${CONTENTS}/MacOS/The Sims 4: replacing existing signature\n` +
      `${CONTENTS}/MacOS/The Sims 4: code object is not signed at all\n` +
      `In subcomponent: ${file}\n`,
  );

function recordingMover(): FileMover & { moves: string[] } {
  const moves: string[] = [];
  return {
    moves,
    setAside(filePath) {
      moves.push(`aside ${filePath}`);
      return `/tmp/aside/${filePath.split('/').pop()}`;
    },
    restore(asidePath, filePath) {
      moves.push(`restore ${filePath}`);
    },
  };
}

describe('strayFileNamedBy', () => {
  it('names a loose file directly in Contents', () => {
    expect(strayFileNamedBy(String(strayError(`${CONTENTS}/imgui.ini`)), CONTENTS)).toBe(`${CONTENTS}/imgui.ini`);
  });

  it('refuses files the bundle needs or that live deeper in it', () => {
    expect(strayFileNamedBy(String(strayError(`${CONTENTS}/Info.plist`)), CONTENTS)).toBeNull();
    expect(strayFileNamedBy(String(strayError(`${CONTENTS}/PkgInfo`)), CONTENTS)).toBeNull();
    expect(strayFileNamedBy(String(strayError(`${CONTENTS}/MacOS/The Sims 4.original`)), CONTENTS)).toBeNull();
    expect(strayFileNamedBy(String(strayError(`${CONTENTS}/Frameworks/libfoo.dylib`)), CONTENTS)).toBeNull();
  });

  it('is null for any other codesign failure', () => {
    expect(strayFileNamedBy('Command failed: codesign: The Sims 4: No such file or directory', CONTENTS)).toBeNull();
  });
});

describe('signWithStrayFilesAside', () => {
  it('signs once and moves nothing when codesign succeeds', async () => {
    const mover = recordingMover();
    const run = vi.fn().mockResolvedValue(undefined);
    await signWithStrayFilesAside(CONTENTS, run, mover);
    expect(run).toHaveBeenCalledTimes(1);
    expect(mover.moves).toEqual([]);
  });

  it('sets the named file aside, signs again and puts it back', async () => {
    const mover = recordingMover();
    const run = vi
      .fn()
      .mockRejectedValueOnce(strayError(`${CONTENTS}/imgui.ini`))
      .mockResolvedValue(undefined);
    await signWithStrayFilesAside(CONTENTS, run, mover);
    expect(run).toHaveBeenCalledTimes(2);
    expect(mover.moves).toEqual([`aside ${CONTENTS}/imgui.ini`, `restore ${CONTENTS}/imgui.ini`]);
  });

  it('handles several stray files and restores them in reverse order', async () => {
    const mover = recordingMover();
    const run = vi
      .fn()
      .mockRejectedValueOnce(strayError(`${CONTENTS}/imgui.ini`))
      .mockRejectedValueOnce(strayError(`${CONTENTS}/notes.txt`))
      .mockResolvedValue(undefined);
    await signWithStrayFilesAside(CONTENTS, run, mover);
    expect(run).toHaveBeenCalledTimes(3);
    expect(mover.moves).toEqual([
      `aside ${CONTENTS}/imgui.ini`,
      `aside ${CONTENTS}/notes.txt`,
      `restore ${CONTENTS}/notes.txt`,
      `restore ${CONTENTS}/imgui.ini`,
    ]);
  });

  it('puts the file back and rethrows when signing still fails', async () => {
    const mover = recordingMover();
    const other = new Error('Command failed: codesign: something else');
    const run = vi
      .fn()
      .mockRejectedValueOnce(strayError(`${CONTENTS}/imgui.ini`))
      .mockRejectedValueOnce(other);
    await expect(signWithStrayFilesAside(CONTENTS, run, mover)).rejects.toBe(other);
    expect(mover.moves).toEqual([`aside ${CONTENTS}/imgui.ini`, `restore ${CONTENTS}/imgui.ini`]);
  });

  it('never touches a file it is not allowed to', async () => {
    const mover = recordingMover();
    const error = strayError(`${CONTENTS}/Info.plist`);
    const run = vi.fn().mockRejectedValue(error);
    await expect(signWithStrayFilesAside(CONTENTS, run, mover)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(mover.moves).toEqual([]);
  });
});
