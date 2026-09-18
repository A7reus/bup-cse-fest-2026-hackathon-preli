/**
 * Deterministic guardrails (Problem Statement Sec 08).
 * LLM output is UNTRUSTED until this passes.
 * Normalizes where safe (sort/dedupe hours, clamp factors) and
 * rejects anything that would invent constraints.
 */

const ALLOWED = new Set([
  'solar_reduction',
  'minimum_battery_reserve',
  'no_charge_window',
  'no_discharge_window',
  'max_grid_window',
  'no_op',
]);

function isSortedAscUnique(hours) {
  for (let i = 0; i < hours.length; i++) {
    if (!Number.isInteger(hours[i]) || hours[i] < 0 || hours[i] > 23) return false;
    if (i > 0 && hours[i] <= hours[i - 1]) return false;
  }
  return true;
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return NaN;
}

function normalizeHours(hours) {
  if (!Array.isArray(hours)) return null;
  const ints = [];
  for (const h of hours) {
    const n = toNumber(h);
    if (!Number.isInteger(n) || n < 0 || n > 23) return null; // out-of-range/junk -> invalid
    ints.push(n);
  }
  const uniq = [...new Set(ints)].sort((a, b) => a - b);
  if (uniq.length === 0) return null;
  return uniq;
}

/**
 * Validate + normalize one entry. Returns {ok, entry} or {ok:false, reason}.
 */
function guardEntry(raw, battery) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'entry not an object' };
  const { note_index, applies, directive_type, structured_adjustment } = raw;

  if (!ALLOWED.has(directive_type)) return { ok: false, reason: `bad directive_type ${directive_type}` };
  if (typeof applies !== 'boolean') return { ok: false, reason: 'applies must be boolean' };

  if (directive_type === 'no_op') {
    if (applies !== false) return { ok: false, reason: 'no_op must have applies=false' };
    if (structured_adjustment !== null) return { ok: false, reason: 'no_op adjustment must be null' };
    return {
      ok: true,
      entry: {
        note_index, applies: false, directive_type: 'no_op', structured_adjustment: null,
        explanation: typeof raw.explanation === 'string' && raw.explanation ? raw.explanation : 'No effect on the 24-hour schedule.',
      },
    };
  }

  // non-no_op must have applies=true
  if (applies !== true) return { ok: false, reason: `${directive_type} must have applies=true` };
  if (!structured_adjustment || typeof structured_adjustment !== 'object') {
    return { ok: false, reason: 'missing structured_adjustment' };
  }
  const hours = normalizeHours(structured_adjustment.hours);
  if (!hours) return { ok: false, reason: 'invalid hours' };

  const explanation = typeof raw.explanation === 'string' && raw.explanation
    ? raw.explanation.slice(0, 500)
    : 'Operator directive applied.';

  if (directive_type === 'solar_reduction') {
    let f = toNumber(structured_adjustment.factor);
    // Model sometimes emits a percentage (e.g. 20 instead of 0.2) — repair deterministically.
    if (Number.isFinite(f) && f > 1 && f <= 100) f = f / 100;
    if (!Number.isFinite(f) || f < 0 || f > 1) {
      return { ok: false, reason: 'solar factor must be 0..1' };
    }
    // exact shape: only hours+factor
    return { ok: true, entry: { note_index, applies: true, directive_type, structured_adjustment: { hours, factor: f }, explanation } };
  }
  if (directive_type === 'minimum_battery_reserve') {
    let v = toNumber(structured_adjustment.minimum_energy_kwh);
    // A leaked fraction-of-capacity (e.g. 0.5) is repaired into absolute kWh.
    if (Number.isFinite(v) && v > 0 && v <= 1 && battery.capacity_kwh > 1) v = v * battery.capacity_kwh;
    if (!Number.isFinite(v) || v < 0) {
      return { ok: false, reason: 'reserve must be 0..capacity' };
    }
    if (v > battery.capacity_kwh) v = battery.capacity_kwh;
    return { ok: true, entry: { note_index, applies: true, directive_type, structured_adjustment: { hours, minimum_energy_kwh: v }, explanation } };
  }
  if (directive_type === 'max_grid_window') {
    const v = toNumber(structured_adjustment.max_grid_kwh);
    if (!Number.isFinite(v) || v < 0) {
      return { ok: false, reason: 'max_grid must be >=0' };
    }
    return { ok: true, entry: { note_index, applies: true, directive_type, structured_adjustment: { hours, max_grid_kwh: v }, explanation } };
  }
  if (directive_type === 'no_charge_window' || directive_type === 'no_discharge_window') {
    return { ok: true, entry: { note_index, applies: true, directive_type, structured_adjustment: { hours }, explanation } };
  }
  return { ok: false, reason: 'unknown type' };
}

/**
 * Guard full array. Returns {ok, entries} — ok=false if count/order/type invalid.
 */
function guardAll(rawArr, noteCount, battery) {
  if (!Array.isArray(rawArr) || rawArr.length !== noteCount) {
    return { ok: false, reason: `expected ${noteCount} entries, got ${Array.isArray(rawArr) ? rawArr.length : typeof rawArr}` };
  }
  const entries = [];
  for (let i = 0; i < rawArr.length; i++) {
    const r = guardEntry(rawArr[i], battery);
    if (!r.ok) return { ok: false, reason: `note ${i}: ${r.reason}` };
    // enforce note_index mapping
    if (r.entry.note_index !== i) return { ok: false, reason: `note_index mismatch at position ${i}` };
    entries.push(r.entry);
  }
  return { ok: true, entries };
}

module.exports = { guardAll, guardEntry, normalizeHours, ALLOWED };
