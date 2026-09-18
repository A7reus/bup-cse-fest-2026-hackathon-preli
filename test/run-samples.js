/**
 * Local judge replica: replays all 10 public samples against the service
 * WITHOUT hard-coding note wording.
 * Checks: interpretation semantics, directive application, GridWise validity,
 * totals consistency, and cost vs reference (informational — lower is better).
 *
 * Usage:
 *   npm test                              # boots the API in-process
 *   npm run test:offline                  # skips the LLM (no API quota used)
 *   BASE_URL=https://<your-app>.onrender.com npm test   # against a deployment
 */
const fs = require('fs');
const path = require('path');

const PACK = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json'), 'utf8'));

const TOL = 0.02;

function eq(a, b, tol = TOL) { return Math.abs(a - b) <= tol; }
function arrEq(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]); }

async function post(base, scenario) {
  const res = await fetch(`${base}/optimize-energy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scenario),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function checkInterpretation(got, want) {
  const errs = [];
  if (!Array.isArray(got) || got.length !== want.length) { errs.push(`interpretation length ${got?.length} != ${want.length}`); return errs; }
  for (let i = 0; i < want.length; i++) {
    const g = got[i], w = want[i];
    if (g.note_index !== w.note_index) errs.push(`note ${i}: note_index ${g.note_index} != ${w.note_index}`);
    if (g.applies !== w.applies) errs.push(`note ${i}: applies ${g.applies} != ${w.applies}`);
    if (g.directive_type !== w.directive_type) errs.push(`note ${i}: type ${g.directive_type} != ${w.directive_type}`);
    const gh = g.structured_adjustment, wh = w.structured_adjustment;
    if (wh === null) { if (gh !== null) errs.push(`note ${i}: expected null adjustment`); }
    else {
      if (!gh) errs.push(`note ${i}: missing adjustment`);
      else {
        if (!arrEq(gh.hours, wh.hours)) errs.push(`note ${i}: hours [${gh.hours}] != [${wh.hours}]`);
        for (const k of ['factor', 'minimum_energy_kwh', 'max_grid_kwh']) {
          if (wh[k] !== undefined && !eq(gh[k], wh[k])) errs.push(`note ${i}: ${k} ${gh[k]} != ${wh[k]}`);
        }
      }
    }
  }
  return errs;
}

function replay(scenario, resp) {
  const errs = [];
  const hours = [...scenario.hours].sort((a, b) => a.hour - b.hour);
  const batt = scenario.battery;
  // effective solar from OUR ground-truth (expected_output interpretation), like the hidden judge
  const effSol = hours.map((h) => h.solar_kwh);
  const refInterp = PACK.cases.find((c) => c.input.scenario_id === scenario.scenario_id).expected_output.directive_interpretation;
  for (const d of refInterp) {
    if (d.directive_type === 'solar_reduction' && d.applies) {
      for (const h of d.structured_adjustment.hours) effSol[h] = hours[h].solar_kwh * d.structured_adjustment.factor;
    }
  }
  const plan = resp.hourly_plan;
  if (!Array.isArray(plan) || plan.length !== 24) { errs.push('plan must have 24 entries'); return errs; }
  const byH = new Map(plan.map((p) => [p.hour, p]));
  let ePrev = batt.initial_energy_kwh;
  for (let h = 0; h < 24; h++) {
    const p = byH.get(h);
    if (!p) { errs.push(`missing hour ${h}`); continue; }
    const ch = p.battery_action === 'charge' ? p.battery_kwh : 0;
    const dis = p.battery_action === 'discharge' ? p.battery_kwh : 0;
    if (p.solar_used_kwh - effSol[h] > 0.02) errs.push(`h${h}: solar ${p.solar_used_kwh} > eff ${effSol[h]}`);
    const bal = Math.abs(p.grid_kwh + p.solar_used_kwh + dis - hours[h].demand_kwh - ch);
    if (bal > 0.05) errs.push(`h${h}: balance off by ${bal.toFixed(3)}`);
    const eExp = ePrev + ch - dis;
    if (Math.abs(p.battery_energy_after_kwh - eExp) > 0.05) errs.push(`h${h}: transition`);
    ePrev = p.battery_energy_after_kwh;
  }
  if (Math.abs(ePrev - batt.initial_energy_kwh) > 0.02) errs.push('neutrality violated');
  // totals
  let g = 0, c = 0, pk = 0;
  const price = new Map(hours.map((h) => [h.hour, h.tariff_bdt_per_kwh]));
  for (const p of plan) { g += p.grid_kwh; c += p.grid_kwh * price.get(p.hour); pk = Math.max(pk, p.grid_kwh); }
  if (!eq(resp.total_grid_kwh, g)) errs.push(`total_grid ${resp.total_grid_kwh} vs ${g.toFixed(2)}`);
  if (!eq(resp.total_cost_bdt, c, 0.5)) errs.push(`total_cost ${resp.total_cost_bdt} vs ${c.toFixed(2)}`);
  if (!eq(resp.peak_grid_kwh, pk)) errs.push(`peak ${resp.peak_grid_kwh} vs ${pk.toFixed(2)}`);
  return errs;
}

(async () => {
  // Boot the API in-process unless BASE_URL points at a deployment.
  let base = process.env.BASE_URL;
  let server = null;
  if (!base) {
    const app = require('../src/app');
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const BASE = base;
  console.log(`Testing ${BASE} against ${PACK.cases.length} public samples${process.env.GRIDWISE_FORCE_FALLBACK === '1' ? ' (offline: LLM bypassed)' : ''}...\n`);
  const health = await fetch(`${BASE}/health`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  console.log('GET /health ->', JSON.stringify(health));
  let pass = 0;
  for (const c of PACK.cases) {
    const { status, body } = await post(BASE, c.input);
    const ref = c.expected_output;
    let errs = [];
    if (status !== 200) errs.push(`HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`);
    else {
      errs.push(...checkInterpretation(body.directive_interpretation, ref.directive_interpretation).map((e) => 'INTERP: ' + e));
      errs.push(...replay(c.input, body).map((e) => 'REPLAY: ' + e));
      if (body.scenario_id !== c.input.scenario_id) errs.push('scenario_id echo mismatch');
      const costInfo = `cost team=${body.total_cost_bdt} ref=${ref.total_cost_bdt} ratio=${(ref.total_cost_bdt / Math.max(1e-9, body.total_cost_bdt)).toFixed(4)}`;
      console.log(`--- ${c.id} (${c.label}) --`);
      console.log('   ', costInfo);
      if (errs.length === 0) console.log('    PASS');
    }
    if (errs.length) { console.log(`--- ${c.id} FAIL ---`); errs.forEach((e) => console.log('    x', e)); }
    else pass++;
  }
  console.log(`\n${pass}/${PACK.cases.length} samples passed (interpretation + replay + totals).`);
  const code = pass === PACK.cases.length ? 0 : 1;
  if (server) server.close(() => process.exit(code));
  else process.exit(code);
})();
