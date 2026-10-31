import { describe, expect, it } from 'vitest';
import { SettingsEnum } from 'main/sentient-sims/models/SettingsEnum';
import { mockApiContext } from './util';

// The one switch (2026-10-27): on = the Jev day, off = release/4.6's autonomy. Every getter
// the two autonomies differ on answers from it.
describe('jevDayAutonomy', () => {
  it("off by default: release/4.6's autonomy", () => {
    const ctx = mockApiContext();
    expect(ctx.settings.jevDayAutonomy).toBe(false);
    expect(ctx.settings.cognitionLegacyTick).toBe(true);
    expect(ctx.settings.intentionRowsEnabled).toBe(false);
  });

  it('on: rows, pie, gate, night call and Jev', () => {
    const ctx = mockApiContext();
    ctx.settings.openrouterKey = 'or-key';
    ctx.settings.set(SettingsEnum.JEV_DAY_AUTONOMY, true);
    expect(ctx.settings.jevDayAutonomy).toBe(true);
    expect(ctx.settings.cognitionLegacyTick).toBe(false);
    expect(ctx.settings.intentionRowsEnabled).toBe(true);
    expect(ctx.settings.cognitionVocabulary).toBe('pie');
    expect(ctx.settings.cognitionGateEnabled).toBe(true);
    expect(ctx.settings.intentionNightCallEnabled).toBe(true);
    expect(ctx.settings.decisionProvider).toBe('jev');
    expect(ctx.settings.jevSceneImpulse).toBe(true);
    expect(ctx.decisions.enabled()).toBe(true);
  });

  it("off: release/4.6's autonomy, whatever the per-feature settings say", () => {
    const ctx = mockApiContext();
    ctx.settings.openrouterKey = 'or-key';
    ctx.settings.set(SettingsEnum.JEV_DAY_AUTONOMY, false);
    ctx.settings.set(SettingsEnum.INTENTION_ROWS_ENABLED, true);
    ctx.settings.set(SettingsEnum.DECISION_PROVIDER, 'jev');
    expect(ctx.settings.cognitionLegacyTick).toBe(true);
    expect(ctx.settings.intentionRowsEnabled).toBe(false);
    expect(ctx.settings.cognitionVocabulary).toBe('whitelist');
    expect(ctx.settings.cognitionGateEnabled).toBe(false);
    expect(ctx.settings.intentionNightCallEnabled).toBe(false);
    expect(ctx.settings.decisionProvider).toBe('off');
    expect(ctx.settings.jevSceneImpulse).toBe(false);
    expect(ctx.decisions.enabled()).toBe(false);
    // Back on: the stored per-feature values apply again
    ctx.settings.set(SettingsEnum.JEV_DAY_AUTONOMY, true);
    expect(ctx.settings.cognitionLegacyTick).toBe(false);
    expect(ctx.settings.decisionProvider).toBe('jev');
  });
});
