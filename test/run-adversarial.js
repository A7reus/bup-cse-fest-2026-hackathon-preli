/**
 * Adversarial fine-tuning harness (team-authored cases, not organizer samples).
 * For each case: interpretation-exact vs fixture ground truth, then a full
 * judge-style replay of the returned schedule against that ground truth
 * (balance, effective solar, battery bounds/rates/transitions, directive
 * windows, end-of-day neutrality, totals self-consistency).
 *
 * Usage:
 *   node test/run-adversarial.js                (boots the API in-process)
 *   BASE_URL=https://<deployment> node test/run-adversarial.js
 *   GRIDWISE_FORCE_FALLBACK=1 node test/run-adversarial.js   (backup path)
 */
const fs = require('fs');
const path = require('path');

const PACK = JSON.parse(fs.readFileSync(path.join(__dirname, 'adversarial-cases.json'), 'utf8'));
const PROF = PACK.base_profile_a;
const TOL = 0.02;

function expandHours(c) {
  if (Array.isArray(c.input.hours)) return c.input.hours;
  return PROF.demand_kwh.map((d, h) => ({
    hour: h,
    demand_kwh: d,
    solar_kwh: PROF.solar_kwh[h],
    tariff_bdt_per_kwh: PROF.tariff_bdt_per_kwh[h],
  }));
}

function eq(a, b, tol = TOL) { return Math.abs(a - b) <= tol; }
function arrEq(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]); }

function checkInterpretation(got, want) {
  const errs = [];
  if (!Array.isArray(got) || got.length !== want.length) { errs.push(`length ${got?.length} != ${want.length}`); return errs; }
  for (let i = 0; i < want.length; i++) {
    const g = got[i], w = want[i];
    if (g.note_index !== w.note_index) errs.push(`note ${i}: note_index`);
    if (g.applies !== w.applies) errs.push(`note ${i}: applies ${g.applies} != ${w.applies}`);
    if (g.directive_type !== w.directive_type) errs.push(`note ${i}: type ${g.directive_type} != ${w.directive_type}`);
    const gh = g.structured_adjustment, wh = w.structured_adjustment;
    if (wh === null || wh === undefined) { if (gh !== null) errs.push(`note ${i}: expected null adjustment, got ${JSON.stringify(gh)}`); }
    else {
      if (!gh) errs.push(`note ${i}: missing adjustment`);
      else {
        if (wh.hours && !arrEq(gh.hours, wh.hours)) errs.push(`note ${i}: hours [${gh.hours}] != [${wh.hours}]`);
        for (const k of ['factor', 'minimum_energy_kwh', 'max_grid_kwh']) {
          if (wh[k] !== undefined && !eq(gh[k], wh[k])) errs.push(`note ${i}: ${k} ${gh[k]} != ${wh[k]}`);
        }
      }
    }
  }
  return errs;
}

/** Judge-style replay against fixture ground-truth directives. */
function replay(hours, battery, truth, resp) {
  const errs = [];
  const effSol = hours.map((h) => h.solar_kwh);
  const minAct = hours.map(() => battery.minimum_energy_kwh);
  const noCh = new Set(), noDis = new Set(), cap = hours.map(() => Infinity);
  for (const d of truth) {
    if (d.directive_type === 'no_op' || d.applies === false) continue;
    const a = d.structured_adjustment;
    if (d.directive_type === 'solar_reduction') for (const h of a.hours) effSol[h] = hours[h].solar_kwh * a.factor;
    if (d.directive_type === 'minimum_battery_reserve') for (const h of a.hours) minAct[h] = Math.max(minAct[h], a.minimum_energy_kwh);
    if (d.directive_type === 'no_charge_window') for (const h of a.hours) noCh.add(h);
    if (d.directive_type === 'no_discharge_window') for (const h of a.hours) noDis.add(h);
    if (d.directive_type === 'max_grid_window') for (const h of a.hours) cap[h] = Math.min(cap[h], a.max_grid_kwh);
  }
  const plan = resp.hourly_plan;
  if (!Array.isArray(plan) || plan.length !== 24) { errs.push('plan must have 24 entries'); return errs; }
  const byH = new Map(plan.map((p) => [p.hour, p]));
  let ePrev = battery.initial_energy_kwh;
  for (let h = 0; h < 24; h++) {
    const p = byH.get(h);
    if (!p) { errs.push(`missing hour ${h}`); continue; }
    const ch = p.battery_action === 'charge' ? p.battery_kwh : 0;
    const dis = p.battery_action === 'discharge' ? p.battery_kwh : 0;
    if (p.solar_used_kwh - effSol[h] > TOL) errs.push(`h${h}: solar overuse`);
    if (ch > battery.max_charge_kwh_per_hour + TOL) errs.push(`h${h}: charge rate`);
    if (dis > battery.max_discharge_kwh_per_hour + TOL) errs.push(`h${h}: discharge rate`);
    if (noCh.has(h) && ch > TOL) errs.push(`h${h}: no_charge violated`);
    if (noDis.has(h) && dis > TOL) errs.push(`h${h}: no_discharge violated`);
    if (p.grid_kwh - cap[h] > TOL) errs.push(`h${h}: grid cap violated`);
    if (Math.abs(p.grid_kwh + p.solar_used_kwh + dis - hours[h].demand_kwh - ch) > 0.05) errs.push(`h${h}: balance`);
    if (Math.abs(p.battery_energy_after_kwh - (ePrev + ch - dis)) > 0.05) errs.push(`h${h}: transition`);
    if (minAct[h] - p.battery_energy_after_kwh > TOL) errs.push(`h${h}: reserve`);
    if (p.battery_energy_after_kwh - battery.capacity_kwh > TOL) errs.push(`h${h}: capacity`);
    ePrev = p.battery_energy_after_kwh;
  }
  if (Math.abs(ePrev - battery.initial_energy_kwh) > TOL) errs.push('neutrality');
  let g = 0, c = 0, pk = 0;
  const price = new Map(hours.map((h) => [h.hour, h.tariff_bdt_per_kwh]));
  for (const p of plan) { g += p.grid_kwh; c += p.grid_kwh * price.get(p.hour); pk = Math.max(pk, p.grid_kwh); }
  if (!eq(resp.total_grid_kwh, g)) errs.push('total_grid mismatch');
  if (!eq(resp.total_cost_bdt, c, 0.5)) errs.push('total_cost mismatch');
  if (!eq(resp.peak_grid_kwh, pk)) errs.push('peak mismatch');
  return errs;
}

(async () => {
  let base = process.env.BASE_URL;
  let server = null;
  if (!base) {
    const app = require('../src/app');
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  console.log(`Testing ${base} against ${PACK.cases.length} adversarial cases${process.env.GRIDWISE_FORCE_FALLBACK === '1' ? ' (offline)' : ''}...\n`);
  let pass = 0;
  for (const c of PACK.cases) {
    const input = { ...c.input, hours: expandHours(c) };
    let errs = [];
    try {
      const res = await fetch(`${base}/optimize-energy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status !== 200) errs.push(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      else {
        errs.push(...checkInterpretation(body.directive_interpretation, c.expected_interpretation).map((e) => 'INTERP: ' + e));
        errs.push(...replay(input.hours, input.battery, c.expected_interpretation, body).map((e) => 'REPLAY: ' + e));
        if (body.scenario_id !== c.input.scenario_id) errs.push('scenario_id echo mismatch');
        const via = (body.directive_interpretation || []).some((d) => (d.explanation || '').startsWith('Backup parser')) ? 'backup' : 'LLM';
        console.log(`--- ${c.id} (${c.label}) [${via}] cost=${body.total_cost_bdt} ---`);
      }
    } catch (e) { errs.push('request error: ' + e.message); }
    if (errs.length) { console.log(`--- ${c.id} FAIL ---`); errs.forEach((e) => console.log('    x', e)); }
    else { console.log('    PASS'); pass++; }
  }
  console.log(`\n${pass}/${PACK.cases.length} adversarial cases passed.`);
  const code = pass === PACK.cases.length ? 0 : 1;
  if (server) server.close(() => process.exit(code));
  else process.exit(code);
})();
