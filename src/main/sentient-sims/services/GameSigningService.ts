import * as fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import log from 'electron-log';
import { ApiContext } from './ApiContext';

const execFileAsync = promisify(execFile);

// The entitlement that lets the hardened-runtime game load dylibs not signed by
// EA (the dev ImGui overlay and _ctypes.dylib). Its presence means signed.
const LIBRARY_VALIDATION_ENTITLEMENT = 'com.apple.security.cs.disable-library-validation';

// Fallback install locations searched when the configured path is missing.
const CANDIDATE_APP_PATHS = ['/Applications/EA Games/The Sims 4.app', '/Applications/The Sims 4.app'];

// How many stray files one signing run will set aside before giving up.
const MAX_STRAY_FILES = 8;

export class GameSigningService {
  private ctx: ApiContext;

  constructor(ctx: ApiContext) {
    this.ctx = ctx;
  }

  get supported(): boolean {
    return process.platform === 'darwin';
  }

  // The configured app bundle if it exists, otherwise the first candidate that
  // does, otherwise the configured path.
  private resolveGameExePath(): string {
    const configured = this.ctx.settings.gameAppPath;
    if (configured && fs.existsSync(exePathFor(configured))) {
      return exePathFor(configured);
    }
    const candidate = CANDIDATE_APP_PATHS.find((appPath) => fs.existsSync(exePathFor(appPath)));
    return exePathFor(candidate ?? configured);
  }

  // Verify the game is signed for overlay support and re-sign it if not. Meant
  // for app startup, so it never kills a game the user may be playing: if the
  // signature is missing while the game is running, it logs and leaves it for
  // the next mod update (which runs with the game closed).
  async ensureSigned(): Promise<void> {
    if (!this.supported) {
      return;
    }

    const gameExePath = this.resolveGameExePath();
    if (!fs.existsSync(gameExePath)) {
      log.info(`Skipping game signature check, The Sims 4 executable not found at ${gameExePath}`);
      return;
    }

    if (await this.isSigned(gameExePath)) {
      log.info('Game is already signed for overlay support');
      return;
    }

    if (await this.isGameRunning()) {
      log.warn(
        'Game is not signed for overlay support, but The Sims 4 is running. Skipping re-sign until next update.',
      );
      return;
    }

    log.info('Game is not signed for overlay support, re-signing');
    await this.writeSignature(gameExePath);
  }

  // Re-sign the game exe ad-hoc with the overlay entitlements. No-op off macOS.
  // Idempotent. Kills a running game first, so this is meant for the mod
  // install/update flow (which expects the game to be closed).
  async signGame(): Promise<void> {
    if (!this.supported) {
      return;
    }

    const gameExePath = this.resolveGameExePath();
    if (!fs.existsSync(gameExePath)) {
      log.info(`Skipping game re-sign, The Sims 4 executable not found at ${gameExePath}`);
      return;
    }

    await this.killGameIfRunning();
    await this.writeSignature(gameExePath);
  }

  private async writeSignature(gameExePath: string): Promise<void> {
    const backupPath = `${gameExePath}.original`;
    if (!fs.existsSync(backupPath)) {
      log.info(`Backing up original game exe to ${backupPath}`);
      fs.copyFileSync(gameExePath, backupPath);
    }

    const entitlementsPath = this.ctx.getAssetPath('game-entitlements.mac.plist');
    log.info(`Re-signing ${gameExePath} ad-hoc with entitlements ${entitlementsPath}`);
    await signWithStrayFilesAside(
      contentsDirFor(gameExePath),
      async () => {
        await execFileAsync('codesign', [
          '--force',
          '--sign',
          '-',
          '--entitlements',
          entitlementsPath,
          '--options',
          'runtime',
          gameExePath,
        ]);
      },
      fileMover(),
    );
    log.info('Game re-signed for overlay support');
  }

  private async isSigned(gameExePath: string): Promise<boolean> {
    try {
      // codesign writes the entitlements dump to stderr; -entitlements - streams
      // the XML plist so we can string-match the entitlement key.
      const { stdout, stderr } = await execFileAsync('codesign', ['-d', '--entitlements', '-', gameExePath]);
      return `${stdout}${stderr}`.includes(LIBRARY_VALIDATION_ENTITLEMENT);
    } catch (error) {
      log.error(`Failed to read game exe entitlements: ${String(error)}`);
      return false;
    }
  }

  private async isGameRunning(): Promise<boolean> {
    try {
      await execFileAsync('pgrep', ['-x', 'The Sims 4']);
      return true;
    } catch {
      // pgrep exits non-zero when no matching process is running.
      return false;
    }
  }

  private async killGameIfRunning(): Promise<void> {
    try {
      await execFileAsync('pkill', ['-x', 'The Sims 4']);
      log.info('Killed running The Sims 4 process before re-signing');
    } catch (error) {
      // pkill exits non-zero when no matching process is running; that's fine.
      log.debug(`No running The Sims 4 process to kill (${String(error)})`);
    }
  }
}

function exePathFor(gameAppPath: string): string {
  return path.join(gameAppPath, 'Contents', 'MacOS', 'The Sims 4');
}

function contentsDirFor(gameExePath: string): string {
  return path.dirname(path.dirname(gameExePath));
}

export interface FileMover {
  // Moves the file out of the bundle and returns where it went.
  setAside(filePath: string): string;
  restore(asidePath: string, filePath: string): void;
}

// codesign treats every loose file in the bundle's Contents folder as nested
// code and refuses to sign while one is unsigned ("code object is not signed
// at all / In subcomponent: <path>"). An old overlay build left its imgui.ini
// there and blocked every re-sign on that Mac (ticket 2026-10-29). The file
// codesign names is set aside for the signing and put back after, so EA's
// install stays as it was; nothing codesign did not name is touched.
export async function signWithStrayFilesAside(
  contentsDir: string,
  runCodesign: () => Promise<void>,
  mover: FileMover,
): Promise<void> {
  const setAside: Array<{ from: string; to: string }> = [];
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await runCodesign();
        return;
      } catch (error) {
        const stray = strayFileNamedBy(String(error), contentsDir);
        if (stray === null || attempt >= MAX_STRAY_FILES) {
          throw error;
        }
        log.warn(`codesign refuses the stray file ${stray} in the game bundle; setting it aside while signing`);
        setAside.push({ from: stray, to: mover.setAside(stray) });
      }
    }
  } finally {
    for (const { from, to } of setAside.reverse()) {
      try {
        mover.restore(to, from);
      } catch (error) {
        log.error(`Could not put ${from} back after signing (it is at ${to}): ${String(error)}`);
      }
    }
  }
}

// The loose file a codesign failure names, if it is one we may set aside: a
// plain file directly in Contents (never anything under MacOS, Frameworks or
// Resources, and never Info.plist or PkgInfo, which the bundle needs).
export function strayFileNamedBy(codesignOutput: string, contentsDir: string): string | null {
  const match = /In subcomponent: (.+)$/m.exec(codesignOutput);
  if (!match) {
    return null;
  }
  const named = match[1].trim();
  if (path.dirname(named) !== contentsDir) {
    return null;
  }
  if (['Info.plist', 'PkgInfo'].includes(path.basename(named))) {
    return null;
  }
  return named;
}

function fileMover(): FileMover {
  let asideDir: string | null = null;
  return {
    setAside(filePath) {
      if (!fs.statSync(filePath).isFile()) {
        throw new Error(`${filePath} is not a plain file`);
      }
      asideDir = asideDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sentient-sims-codesign-'));
      const asidePath = path.join(asideDir, path.basename(filePath));
      fs.renameSync(filePath, asidePath);
      return asidePath;
    },
    restore(asidePath, filePath) {
      fs.renameSync(asidePath, filePath);
      log.info(`Put ${filePath} back after signing`);
    },
  };
}
