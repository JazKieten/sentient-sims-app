// The pie-menu vocabulary as the options prompt renders it (autonomy part 2, 2026-10-21).
//
// The mod builds ROWS from the game's own pie menu (interactions/ss_cognition_query.py, kind
// `vocabulary`): one row per item the actor could click right now on themselves, the desire's
// target, the nearest Sims, the phone, their inventory and the nearest usable objects, with a
// deny list and parameter fan-out collapsed to one row with options. The model answers with a
// row id (and an option when the row lists options); validateIntent turns that back into the
// push. The whitelist survives here only as the recipe for travel and the phone: those verbs
// become synthetic `w1..` rows so a go out still carries its destination.
import type { VocabularyRow } from '../models/ActionIntent';

// Whitelist verbs the pie vocabulary keeps (plan decision 5): travel, home, and the phone
// recipes the mod resolves itself. The rule lanes' own verbs (use_toilet, grab_snack,
// cook_meal, enter_lot) never need a row: they are dispatched by rule, not chosen.
export const PIE_KEPT_LOT_VERBS = ['go_out', 'go_home', 'hire_repair_service', 'call_firefighter', 'invite_in'];

export const PIE_ROW_CAP = 60;
export const PIE_GREYED_CAP = 8;

function pretty(text: string): string {
  return text.replace(/_/g, ' ');
}

// Synthetic rows for the kept whitelist verbs this tick actually offers (lot verbs or an
// object provider), minus the hidden ones
export function whitelistRows(
  offered: { lotActions: Set<string>; objectActions: Map<string, string> },
  hidden?: Set<string>,
): VocabularyRow[] {
  const rows: VocabularyRow[] = [];
  PIE_KEPT_LOT_VERBS.forEach((verb) => {
    if (hidden?.has(verb)) {
      return;
    }
    if (!offered.lotActions.has(verb) && !offered.objectActions.has(verb)) {
      return;
    }
    rows.push({
      id: `w${rows.length + 1}`,
      target: 'The household',
      target_kind: 'self',
      label: pretty(verb),
      key: verb,
      source: 'whitelist',
    });
  });
  return rows;
}

export type OfferableRows = {
  // Rows the model may answer with (non-greyed, non-picker, not suppressed), capped
  offered: VocabularyRow[];
  // Greyed rows shown with the game's reason so the model sees why, capped
  greyed: VocabularyRow[];
};

export function offerableRows(rows: VocabularyRow[], suppressed?: Set<string>, cap = PIE_ROW_CAP): OfferableRows {
  const offered: VocabularyRow[] = [];
  const greyed: VocabularyRow[] = [];
  rows.forEach((row) => {
    if (!row.id || !row.key) {
      return;
    }
    if (suppressed?.has(row.key)) {
      return;
    }
    if (row.greyed) {
      if (greyed.length < PIE_GREYED_CAP) {
        greyed.push(row);
      }
      return;
    }
    if (row.picker) {
      return;
    }
    if (offered.length < cap) {
      offered.push(row);
    }
  });
  return { offered, greyed };
}

function targetHeading(row: VocabularyRow): string {
  switch (row.target_kind) {
    case 'self':
      return row.source === 'whitelist' ? 'The household' : 'For yourself';
    case 'sim':
      return `With ${row.target}`;
    case 'phone':
      return 'On the phone';
    case 'inventory':
      return `In your inventory, ${row.target}`;
    default:
      return `At the ${row.target}`;
  }
}

function describeRow(row: VocabularyRow): string {
  let text = `${row.id}. ${row.label}`;
  if (row.category) {
    text += ` (${row.category})`;
  }
  if (row.options && row.options.length > 0) {
    text += ` [options: ${row.options.join(', ')}]`;
  }
  return text;
}

// The OFFERED block: rows grouped by target in first-seen order, greyed rows last with the
// game's reason, and the moment when the mod said the actor cannot start anything new
export function formatVocabularyRows(
  rows: OfferableRows & { whitelist?: VocabularyRow[] },
  cannotStartNow?: { reason?: string; why?: string },
): string {
  const lines: string[] = [];
  lines.push('OFFERED (answer with the row id; add "option" only when the row lists options):');
  const groups = new Map<string, string[]>();
  [...rows.offered, ...(rows.whitelist ?? [])].forEach((row) => {
    const heading = targetHeading(row);
    const group = groups.get(heading) ?? [];
    group.push(describeRow(row));
    groups.set(heading, group);
  });
  groups.forEach((group, heading) => {
    lines.push(`${heading}: ${group.join('; ')}`);
  });
  if (groups.size === 0) {
    lines.push('(nothing can be started right now)');
  }
  if (rows.greyed.length > 0) {
    lines.push(
      `Not now: ${rows.greyed
        .map((row) => `${row.id}. ${row.label}: ${row.reason ?? 'not available right now'} (not now)`)
        .join('; ')}`,
    );
  }
  if (cannotStartNow?.why) {
    lines.push(`Right now: ${cannotStartNow.why}`);
  }
  return lines.join('\n');
}
