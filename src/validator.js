/**
 * Request validation + response replay verification.
 * Judge replays hourly_plan hour-by-hour (Problem Statement Sec 09/11).
 */

const TOL = 0.011; // slightly above 0.01 to survive 2-decimal rounding

function isFiniteNum(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Validate POST /optimize-energy body. Returns {ok, error} or {ok, data}. */
function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Body must be a JSON object' };
  }
  const { scenario_id, operator_notes, hours, battery } = body;
  if (typeof scenario_id !== 'string' || !scenario_id) {
    return { ok: false, status: 400, error: 'scenario_id must be a non-empty string' };
  }
  if (!Array.isArray(operator_notes) || operator_notes.length < 1 || operator_notes.length > 3) {
    return { ok: false, status: 400, error: 'operator_notes must be an array of 1..3 strings' };
  }
  for (const n of operator_notes) {
    if (typeof n !== 'string' || !n.trim()) {
      return { ok: false, status: 400, error: 'each operator_note must be a non-empty string' };
    }
  }
  if (!Array.isArray(hours) || hours.length !== 24) {
    return { ok: false, status: 400, error: 'hours must contain exactly 24 entries' };
  }
  const seen = new Set();
  for (const h of hours) {
    if (!h || typeof h !== 'object') return { ok: false, status: 400, error: 'each hour must be an object' };
    if (!Number.isInteger(h.hour) || h.hour < 0 || h.hour > 23 || seen.has(h.hour)) {
      return { ok: false, status: 400, error: 'hours must be unique integers 0..23' };
    }
    seen.add(h.hour);
    if (!isFiniteNum(h.demand_kwh) || h.demand_kwh < 0) return { ok: false, status: 400, error: `demand_kwh invalid at hour ${h.hour}` };
    if (!isFiniteNum(h.solar_kwh) || h.solar_kwh < 0) return { ok: false, status: 400, error: `solar_kwh invalid at hour ${h.hour}` };
    if (!isFiniteNum(h.tariff_bdt_per_kwh) || h.tariff_bdt_per_kwh < 0) return { ok: false, status: 400, error: `tariff invalid at hour ${h.hour}` };
  }
  if (!battery || typeof battery !== 'object') return { ok: false, status: 400, error: 'battery must be an object' };
  for (const k of ['capacity_kwh', 'initial_energy_kwh', 'minimum_energy_kwh', 'max_charge_kwh_per_hour', 'max_discharge_kwh_per_hour']) {
    if (!isFiniteNum(battery[k]) || battery[k] < 0) return { ok: false, status: 400, error: `battery.${k} must be a non-negative number` };
  }
  if (battery.initial_energy_kwh > battery.capacity_kwh) return { ok: false, status: 422, error: 'initial energy exceeds capacity' };
  if (battery.minimum_energy_kwh > battery.capacity_kwh) return { ok: false, status: 422, error: 'minimum energy exceeds capacity' };

  const sorted = [...hours].sort((a, b) => a.hour - b.hour);
  return { ok: true, data: { scenario_id, operator_notes, hours: sorted, battery } };
}

/**
 * Replay plan against directives + GridWise rules.
 * Returns {ok, reason} — ok=false means INVALID (no optimization credit).
 */
function replayCheck(hours, battery, directives, plan, eff) {
  if (!Array.isArray(plan) || plan.length !== 24) return { ok: false, reason: 'plan must have 24 entries' };
  const byHour = new Map(plan.map((p) => [p.hour, p]));
  if (byHour.size !== 24) return { ok: false, reason: 'plan hours must be unique 0..23' };
  for (let h = 0; h < 24; h++) if (!byHour.has(h)) return { ok: false, reason: `missing hour ${h}` };

  let ePrev = battery.initial_energy_kwh;
  for (let h = 0; h < 24; h++) {
    const p = byHour.get(h);
    const dem = hours[h].demand_kwh;
    const esol = eff.effectiveSolar[h];
    if (!isFiniteNum(p.grid_kwh) || p.grid_kwh < -TOL) return { ok: false, reason: `grid negative h${h}` };
    if (!isFiniteNum(p.solar_used_kwh) || p.solar_used_kwh < -TOL || p.solar_used_kwh - esol > TOL) {
      return { ok: false, reason: `solar_used violates effective solar h${h} (${p.solar_used_kwh} > ${esol})` };
    }
    if (!['charge', 'discharge', 'idle'].includes(p.battery_action)) return { ok: false, reason: `bad action h${h}` };
    if (!isFiniteNum(p.battery_kwh) || p.battery_kwh < -TOL) return { ok: false, reason: `battery_kwh negative h${h}` };
    if (p.battery_action === 'idle' && Math.abs(p.battery_kwh) > TOL) return { ok: false, reason: `idle must have 0 kwh h${h}` };
    if (!isFiniteNum(p.battery_energy_after_kwh)) return { ok: false, reason: `bad E_after h${h}` };

    const ch = p.battery_action === 'charge' ? p.battery_kwh : 0;
    const dis = p.battery_action === 'discharge' ? p.battery_kwh : 0;
    if (ch - battery.max_charge_kwh_per_hour > TOL) return { ok: false, reason: `charge rate h${h}` };
    if (dis - battery.max_discharge_kwh_per_hour > TOL) return { ok: false, reason: `discharge rate h${h}` };
    if (eff.noCharge.has(h) && ch > TOL) return { ok: false, reason: `no_charge violated h${h}` };
    if (eff.noDischarge.has(h) && dis > TOL) return { ok: false, reason: `no_discharge violated h${h}` };
    if (p.grid_kwh - eff.maxGrid[h] > TOL) return { ok: false, reason: `max_grid violated h${h}` };

    // transition
    const eExp = ePrev + ch - dis;
    if (Math.abs(p.battery_energy_after_kwh - eExp) > 0.05) return { ok: false, reason: `transition h${h}` };
    if (p.battery_energy_after_kwh - battery.capacity_kwh > TOL) return { ok: false, reason: `capacity h${h}` };
    if (eff.minActive[h] - p.battery_energy_after_kwh > TOL) return { ok: false, reason: `reserve h${h}` };

    // balance: grid + solar + dis = demand + ch
    const lhs = p.grid_kwh + p.solar_used_kwh + dis;
    const rhs = dem + ch;
    if (Math.abs(lhs - rhs) > 0.05) return { ok: false, reason: `balance h${h}: ${lhs} vs ${rhs}` };

    ePrev = p.battery_energy_after_kwh;
  }
  if (Math.abs(ePrev - battery.initial_energy_kwh) > TOL) {
    return { ok: false, reason: `neutrality: end ${ePrev} != initial ${battery.initial_energy_kwh}` };
  }
  return { ok: true };
}

function computeTotals(hours, plan) {
  let grid = 0, cost = 0, peak = 0;
  const priceByHour = new Map(hours.map((h) => [h.hour, h.tariff_bdt_per_kwh]));
  for (const p of plan) {
    grid += p.grid_kwh;
    cost += p.grid_kwh * priceByHour.get(p.hour);
    peak = Math.max(peak, p.grid_kwh);
  }
  const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  return { total_grid_kwh: r2(grid), total_cost_bdt: r2(cost), peak_grid_kwh: r2(peak) };
}

module.exports = { validateRequest, replayCheck, computeTotals };
