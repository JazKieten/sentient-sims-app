import type { AIActionType } from 'main/sentient-sims/models/AIActionType';
import type { RouteObject } from 'react-router-dom';
import type { ComponentType } from 'react';
import type { RendererTier, TierNavItem, TierProvider, TierSettingsRow, TierSettingsTab } from './types';
import { RENDERER_TIERS } from './index';

export type MergedRendererTiers = {
  routes: RouteObject[];
  navItems: TierNavItem[];
  settingsTabs: TierSettingsTab[];
  settingsRows: TierSettingsRow[];
  providers: TierProvider[];
  overrideActionTypes: AIActionType[];
  debugCards: ComponentType[];
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
  };
}

export const rendererTiers: MergedRendererTiers = mergeRendererTiers(RENDERER_TIERS);
