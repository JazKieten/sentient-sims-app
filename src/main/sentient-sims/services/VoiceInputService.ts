import log from 'electron-log';
import { correctNames } from '../util/nameCorrection';
import { isPlaceholderName } from '../util/simAliases';
import { ApiContext } from './ApiContext';
import { VoiceHotkeyService } from './VoiceHotkeyService';
import { SettingsEnum } from '../models/SettingsEnum';
import { voiceInputMaxRecordMs, voiceInputMinAudioBytes } from '../constants';
import { sendPlayerVoiceMessageToMod, sendPlayerVoiceStatusToMod, sendPopUpNotification } from '../util/notifyRenderer';
import { isWebSocketConnected } from '../websocketServer';
import { getAllBrowserWindows } from '../util/browserWindows';

type VoiceInputState = 'idle' | 'listening' | 'transcribing';

// If the renderer never delivers the recording (window reloaded mid-hold, recorder
// wedged), return to idle so the hotkey keeps working
const audioDeliveryTimeoutMs = 45000;

function notifyAllWindows(message: string, ...args: unknown[]) {
  getAllBrowserWindows().forEach((wnd) => {
    if (!wnd.webContents.isDestroyed()) {
      wnd.webContents.send(message, ...args);
    }
  });
}

// Hold-to-talk orchestration: the global hotkey (main process) starts/stops a renderer
// MediaRecorder over IPC, the audio comes back for transcription, and the transcript
// goes to the mod over the websocket as the active sim's spoken line. The mic is only
// hot between record-start and record-stop.
export class VoiceInputService {
  private readonly ctx: ApiContext;

  private readonly hotkey: VoiceHotkeyService;

  private state: VoiceInputState = 'idle';

  private forceStopTimer?: NodeJS.Timeout;

  private deliveryTimer?: NodeJS.Timeout;

  constructor(ctx: ApiContext, hotkey?: VoiceHotkeyService) {
    this.ctx = ctx;
    this.hotkey = hotkey ?? new VoiceHotkeyService();
  }

  initialize() {
    this.armHotkey();
  }

  shutdown() {
    this.hotkey.shutdown();
  }

  get usingFallbackHotkey(): boolean {
    return this.hotkey.usingFallback;
  }

  onSettingChanged(key: string) {
    if (
      key === (SettingsEnum.VOICE_INPUT_ENABLED as string) ||
      key === (SettingsEnum.VOICE_INPUT_HOTKEY as string) ||
      key === (SettingsEnum.VOICE_INPUT_HOTKEY_MODE as string) ||
      key === (SettingsEnum.VOICE_COMMAND_HOTKEY as string)
    ) {
      this.armHotkey();
    }
  }

  private armHotkey() {
    if (!this.ctx.settings.voiceInputEnabled) {
      this.hotkey.disarm();
      this.reset();
      return;
    }
    this.hotkey.arm(this.ctx.settings.voiceInputHotkey, this.ctx.settings.voiceInputHotkeyMode, {
      onDown: () => {
        this.startListening();
      },
      onUp: () => {
        this.stopListening();
      },
      onToggle: () => {
        if (this.state === 'listening') {
          this.stopListening();
        } else {
          this.startListening();
        }
      },
    });
    // V-8: the second chord — same capture, but the transcript is an order
    this.hotkey.armCommand(this.ctx.settings.voiceCommandHotkey, {
      onDown: () => {
        this.startListening('command');
      },
      onUp: () => {
        this.stopListening();
      },
      onToggle: () => {
        if (this.state === 'listening') {
          this.stopListening();
        } else {
          this.startListening('command');
        }
      },
    });
  }

  // V-8: what the current capture IS — talk to the sim, or an order for the sim
  private captureMode: 'chat' | 'command' = 'chat';

  startListening(mode: 'chat' | 'command' = 'chat') {
    if (!this.ctx.settings.voiceInputEnabled || this.state !== 'idle') {
      return;
    }
    this.captureMode = mode;
    if (!isWebSocketConnected('mod')) {
      sendPopUpNotification('Voice input: the game is not connected');
      return;
    }
    this.state = 'listening';
    notifyAllWindows('voice-record-start');
    sendPlayerVoiceStatusToMod('listening', undefined, {
      speaker: this.ctx.settings.playerSpeakerName,
      mode: this.captureMode,
    });
    // Backstop for a lost keyup (alt-tab mid-hold): never leave the mic hot
    this.forceStopTimer = setTimeout(() => {
      this.stopListening();
    }, voiceInputMaxRecordMs);
  }

  stopListening() {
    if (this.state !== 'listening') {
      return;
    }
    this.clearForceStop();
    this.state = 'transcribing';
    notifyAllWindows('voice-record-stop');
    sendPlayerVoiceStatusToMod('transcribing');
    this.deliveryTimer = setTimeout(() => {
      log.error('Voice recording was never delivered by the renderer');
      this.reset();
    }, audioDeliveryTimeoutMs);
  }

  // Invoked from the renderer once the recording blob is assembled
  async handleAudio(audio: ArrayBuffer, mimeType?: string): Promise<string> {
    try {
      // Shorter than any word: an accidental hotkey tap, dropped without ceremony
      if (audio.byteLength < voiceInputMinAudioBytes) {
        return '';
      }
      const raw = await this.ctx.transcription.transcribe(audio, mimeType);
      if (!raw) {
        sendPlayerVoiceStatusToMod('error', 'Heard nothing');
        return '';
      }
      // V-7 post-pass: snap near-miss names to the sims actually in play. The settings
      // Test button goes through transcribe() directly and stays raw on purpose.
      const text = correctNames(raw, this.sceneNames());
      if (text !== raw) {
        log.info(`Voice input transcript corrected: "${raw}" -> "${text}"`);
      }
      log.info(`Voice input transcript${this.captureMode === 'command' ? ' (command)' : ''}: ${text}`);
      notifyAllWindows('voice-transcript', text);
      if (this.captureMode === 'command') {
        // V-8: an order, not talk — mapped to an offered action and dispatched; the
        // chat event is skipped entirely
        await this.ctx.voiceCommand.handleCommand(text);
        return text;
      }
      sendPlayerVoiceMessageToMod(text);
      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendPlayerVoiceStatusToMod('error', 'Transcription failed');
      sendPopUpNotification(`Voice transcription failed: ${message}`);
      return '';
    } finally {
      this.reset();
    }
  }

  // Only the sims on the lot and the ones perceived in the room — the pool correctNames
  // is allowed to snap a spoken token to. The wider pools (everyone the household has met,
  // the whole participant table) still ride the transcription prompt via
  // TranscriptionService.namePrompt, where a name can only help Whisper hear it right;
  // here they could only rename the person the player is actually talking to.
  private sceneNames(): string[] {
    try {
      const report = this.ctx.simStateCache?.getReport?.();
      const names = new Set<string>();
      (report?.sims ?? []).forEach((entry) => {
        if (entry.sim_name && !isPlaceholderName(entry.sim_name)) {
          names.add(entry.sim_name);
        }
        (entry.sims ?? []).forEach((sim) => {
          // Perception only names sims in the same room (identity is not learned
          // through a wall), so this is exactly who is present
          if (sim.name && !isPlaceholderName(sim.name)) {
            names.add(sim.name);
          }
        });
      });
      return [...names];
    } catch {
      return [];
    }
  }

  // Renderer-side mic failure (no permission, no device, recorder error)
  handleRecordError(message: string) {
    log.error(`Voice recording failed in renderer: ${message}`);
    sendPlayerVoiceStatusToMod('error', 'Microphone unavailable');
    sendPopUpNotification(`Voice input microphone error: ${message}`);
    this.reset();
  }

  private reset() {
    this.clearForceStop();
    if (this.deliveryTimer) {
      clearTimeout(this.deliveryTimer);
      this.deliveryTimer = undefined;
    }
    this.state = 'idle';
  }

  private clearForceStop() {
    if (this.forceStopTimer) {
      clearTimeout(this.forceStopTimer);
      this.forceStopTimer = undefined;
    }
  }
}
