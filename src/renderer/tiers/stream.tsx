// The STREAM tier's renderer entry (release 4.5): the Twitch settings tab. Listed in
// tiers.json, so the core build deletes it and the generated index.tsx never names it.
import type { RendererTier } from './types';
import TwitchSettingsComponent from '../settings/TwitchSettingsComponent';

export const streamRendererTier: RendererTier = {
  name: 'stream',
  settingsTabs: [{ value: 'twitch', label: 'Twitch', Component: TwitchSettingsComponent }],
};
