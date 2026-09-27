// The AUTONOMY tier's renderer entry (release 4.5): the conversation-actions settings row,
// the voice command key, and the provider overrides for the stages only autonomy runs.
// Listed in tiers.json, so the core build deletes it and the generated index.tsx never
// names it.
import { AIActionType } from 'main/sentient-sims/models/AIActionType';
import type { RendererTier } from './types';
import ConversationActionsSettingsComponent from '../settings/ConversationActionsSettingsComponent';
import VoiceCommandKeyRow from '../settings/voice/VoiceCommandKeyRow';

export const autonomyRendererTier: RendererTier = {
  name: 'autonomy',
  settingsRows: [
    { id: 'conversation-actions', Component: ConversationActionsSettingsComponent, after: 'directed-scenes' },
  ],
  overrideActionTypes: [
    AIActionType.COGNITION,
    AIActionType.ACTION_SCENE,
    AIActionType.DAILY_PLAN,
    AIActionType.VOICE_COMMAND,
    AIActionType.ASK_TRIAGE,
    AIActionType.ASK_ACTION_MATCH,
    AIActionType.ASK_DECISION,
  ],
  voiceCommandRow: VoiceCommandKeyRow,
};
