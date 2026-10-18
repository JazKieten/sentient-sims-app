import type { AIActionType } from 'main/sentient-sims/models/AIActionType';
import type { RouteObject } from 'react-router-dom';
import type { ComponentType } from 'react';
import type {
  MemoryTraceDialogProps,
  RendererTier,
  TierNavItem,
  TierProvider,
  TierSettingsRow,
  TierSettingsTab,
  VoiceCommandRowProps,
} from './types';
import { RENDERER_TIERS } from './index';

export type MergedRendererTiers = {
  routes: RouteObject[];
  navItems: TierNavItem[];
  settingsTabs: TierSettingsTab[];
  settingsRows: TierSettingsRow[];
  providers: TierProvider[];
  overrideActionTypes: AIActionType[];
  debugCards: ComponentType[];
  locationsCards: ComponentType[];
  voiceCommandRow?: ComponentType<VoiceCommandRowProps>;
  MemoryTraceDialog?: ComponentType<MemoryTraceDialogProps>;
};

export function mergeRendererTiers(tiers: RendererTier[]): MergedRendererTiers {
  return {
    routes: tiers.flatMap((t) => t.routes ?? []),
    navItems: tiers.flatMap((t) => t.navItems ?? []),
    settingsTabs: tiers.flatMap((t) => t.settingsTabs ?? []),
    settingsRows: tiers.flatMap((t) => t.settingsRows ?? []),
    providers: tiers.flatMap((t) => t.providers ?? []),
    overrideActionTypes: tiers.flatMap((t) => t.overrideActionTypes ?? []),
    debugCards: tiers.flatMap((t) => t.debugCards ?? []),
    locationsCards: tiers.flatMap((t) => t.locationsCards ?? []),
    voiceCommandRow: tiers.find((t) => t.voiceCommandRow)?.voiceCommandRow,
    MemoryTraceDialog: tiers.find((t) => t.MemoryTraceDialog)?.MemoryTraceDialog,
  };
}

export const rendererTiers: MergedRendererTiers = mergeRendererTiers(RENDERER_TIERS);

export function hasTierRoute(path: string): boolean {
  return rendererTiers.routes.some((route) => route.path === path);
}
