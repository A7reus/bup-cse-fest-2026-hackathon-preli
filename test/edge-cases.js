/**
 * GridWise LLM — Comprehensive edge-case + rubric-compliance test suite.
 *
 * Target: deployed endpoint by default, or local (in-process) if BASE_URL is
 * set to a localhost URL. To run against Render:
 *   npm run test:maruf-edge
 * or with an explicit URL:
 *   BASE_URL=https://gridwise-llm-d780.onrender.com npm run test:maruf-edge
 *
 * To run locally (in-process, uses your local .env):
 *   BASE_URL=http://127.0.0.1:8080 npm run test:maruf-edge
 * or leave BASE_URL unset and pass RUN_LOCAL=1:
 *   RUN_LOCAL=1 npm run test:maruf-edge
 *
 * Usage:
 *   npm run test:maruf-edge                              # against Render
 *   EDGE_DELAY_MS=3000 npm run test:maruf-edge           # slower (safer for free tier)
 *   GRIDWISE_FORCE_FALLBACK=1 npm run test:maruf-edge    # skip LLM tiers (local only)
 */

const fs = require('fs');
const path = require('path');

const PACK = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', 'BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json'),
    'utf8'
  )
);

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------
const DEPLOYED_URL = process.env.DEPLOYED_URL || 'https://gridwise-llm-d780.onrender.com';
const RUN_LOCAL = process.env.RUN_LOCAL === '1';
const USE_LOCAL = RUN_LOCAL || !DEPLOYED_URL;

// ---------------------------------------------------------------------------
// Config: optional delay between HTTP requests (safety for free tier TPM).
// Default is 2000ms for the deployed endpoint; 0 for local.
// ---------------------------------------------------------------------------
const DEFAULT_DELAY = USE_LOCAL ? 0 : 2000;
const BETWEEN_CALLS_MS = parseInt(process.env.EDGE_DELAY_MS || String(DEFAULT_DELAY), 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.EDGE_TIMEOUT_MS || '60000', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOL = 0.02; // judge tolerance is 0.01; give ourselves 2x headroom

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------
let PASS = 0;
let FAIL = 0;
const FAILURES = [];
const PATH_STATS = { llm: 0, repaired: 0, backup: 0, unknown: 0 };
const LATENCIES = [];
let COLD_START_HIT = false;

function ok(cond, label) {
  if (cond) {
    PASS++;
  } else {
    FAIL++;
    FAILURES.push(label);
    console.log(`    x ${label}`);
  }
}

function approx(a, b, tol = TOL) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------------------
// HTTP helpers (with delay, timeout, and path tracking)
// ---------------------------------------------------------------------------
async function post(base, body, opts = {}) {
  if (BETWEEN_CALLS_MS > 0) await sleep(BETWEEN_CALLS_MS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const res = await fetch(`${base}/optimize-energy`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const ms = Date.now() - t0;
    LATENCIES.push(ms);
    if (ms > 20000 && !COLD_START_HIT) {
      COLD_START_HIT = true;
      console.log(`    [cold-start] first request took ${ms}ms`);
    }

    const pathHeader = res.headers.get('x-interpretation-path') || 'unknown';
    if (pathHeader.startsWith('backup')) PATH_STATS.backup++;
    else if (pathHeader.includes('repaired')) PATH_STATS.repaired++;
    else if (['groq', 'gemini-lite', 'gemini'].includes(pathHeader)) PATH_STATS.llm++;
    else PATH_STATS.unknown++;

    let parsed = null;
    const text = await res.text();
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { _raw: text };
    }
    return { status: res.status, body: parsed, raw: text, path: pathHeader, ms };
  } finally {
    clearTimeout(timer);
  }
}

async function get(base, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}${url}`, { signal: controller.signal });
    LATENCIES.push(Date.now() - t0);
    let parsed = null;
    const text = await res.text();
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { _raw: text };
    }
    return { status: res.status, body: parsed, raw: text };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Scenario builder
// ---------------------------------------------------------------------------
function baseScenario(overrides = {}) {
  const hours = [];
  for (let h = 0; h < 24; h++) {
    hours.push({
      hour: h,
      demand_kwh: 100,
      solar_kwh: h >= 8 && h <= 16 ? 50 : 0,
      tariff_bdt_per_kwh: h >= 18 && h <= 21 ? 20 : 8,
    });
  }
  return {
    scenario_id: 'EDGE-BASE',
    operator_notes: ['No schedule changes today.'],
    hours,
    battery: {
      capacity_kwh: 200,
      initial_energy_kwh: 100,
      minimum_energy_kwh: 30,
      max_charge_kwh_per_hour: 50,
      max_discharge_kwh_per_hour: 50,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Replay the returned plan against GridWise rules.
// ---------------------------------------------------------------------------
function replayPlan(scenario, resp, effectiveSolar) {
  const errs = [];
  const hours = [...scenario.hours].sort((a, b) => a.hour - b.hour);
  const batt = scenario.battery;
  const plan = resp.hourly_plan;
  if (!Array.isArray(plan) || plan.length !== 24) {
    errs.push('plan must have 24 entries');
    return errs;
  }
  const byH = new Map(plan.map((p) => [p.hour, p]));
  if (byH.size !== 24) errs.push('plan hours must be unique 0..23');
  for (let h = 0; h < 24; h++) if (!byH.has(h)) errs.push(`missing hour ${h}`);

  let ePrev = batt.initial_energy_kwh;
  for (let h = 0; h < 24; h++) {
    const p = byH.get(h);
    if (!p) continue;
    const ch = p.battery_action === 'charge' ? p.battery_kwh : 0;
    const dis = p.battery_action === 'discharge' ? p.battery_kwh : 0;

    const esol = effectiveSolar ? effectiveSolar[h] : hours[h].solar_kwh;
    if (p.solar_used_kwh - esol > 0.02) errs.push(`h${h}: solar_used ${p.solar_used_kwh} > effective ${esol}`);
    if (p.solar_used_kwh < -TOL) errs.push(`h${h}: solar_used negative`);
    if (p.grid_kwh < -TOL) errs.push(`h${h}: grid negative (${p.grid_kwh})`);
    if (p.battery_kwh < -TOL) errs.push(`h${h}: battery_kwh negative`);
    if (p.battery_action === 'idle' && Math.abs(p.battery_kwh) > TOL) errs.push(`h${h}: idle but battery_kwh=${p.battery_kwh}`);
    if (ch - batt.max_charge_kwh_per_hour > TOL) errs.push(`h${h}: charge rate exceeded`);
    if (dis - batt.max_discharge_kwh_per_hour > TOL) errs.push(`h${h}: discharge rate exceeded`);

    const lhs = p.grid_kwh + p.solar_used_kwh + dis;
    const rhs = hours[h].demand_kwh + ch;
    if (Math.abs(lhs - rhs) > 0.05) errs.push(`h${h}: balance off (${lhs.toFixed(3)} vs ${rhs.toFixed(3)})`);
    const eExp = ePrev + ch - dis;
    if (Math.abs(p.battery_energy_after_kwh - eExp) > 0.05) errs.push(`h${h}: transition (${p.battery_energy_after_kwh} vs ${eExp})`);
    if (p.battery_energy_after_kwh - batt.capacity_kwh > TOL) errs.push(`h${h}: capacity exceeded`);
    if (batt.minimum_energy_kwh - p.battery_energy_after_kwh > TOL) errs.push(`h${h}: base reserve violated`);
    ePrev = p.battery_energy_after_kwh;
  }
  if (Math.abs(ePrev - batt.initial_energy_kwh) > 0.02) errs.push(`neutrality: end ${ePrev} != initial ${batt.initial_energy_kwh}`);

  let g = 0, c = 0, pk = 0;
  const price = new Map(hours.map((h) => [h.hour, h.tariff_bdt_per_kwh]));
  for (const p of plan) {
    g += p.grid_kwh;
    c += p.grid_kwh * price.get(p.hour);
    pk = Math.max(pk, p.grid_kwh);
  }
  if (!approx(resp.total_grid_kwh, g, 0.5)) errs.push(`total_grid ${resp.total_grid_kwh} vs ${g.toFixed(2)}`);
  if (!approx(resp.total_cost_bdt, c, 1)) errs.push(`total_cost ${resp.total_cost_bdt} vs ${c.toFixed(2)}`);
  if (!approx(resp.peak_grid_kwh, pk, 0.5)) errs.push(`peak ${resp.peak_grid_kwh} vs ${pk.toFixed(2)}`);
  return errs;
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

async function suiteApiContract(base) {
  console.log('\n[API CONTRACT]');

  const h = await get(base, '/health');
  ok(h.status === 200, 'health returns 200');
  ok(h.body && h.body.status === 'ok', 'health body is {"status":"ok"}');

  const bad = await get(base, '/nonexistent');
  ok(bad.status === 404, 'unknown endpoint returns 404');

  const mal = await post(base, '{not valid json');
  ok(mal.status === 400, `malformed JSON returns 400 (got ${mal.status})`);

  const empty = await post(base, '');
  ok(empty.status === 400, `empty body returns 400 (got ${empty.status})`);

  const noId = await post(base, { ...baseScenario(), scenario_id: undefined });
  ok(noId.status === 400, `missing scenario_id returns 400 (got ${noId.status})`);

  const noNotes = await post(base, { ...baseScenario(), operator_notes: [] });
  ok(noNotes.status === 400, `empty operator_notes returns 400 (got ${noNotes.status})`);

  const tooMany = await post(base, { ...baseScenario(), operator_notes: ['a', 'b', 'c', 'd'] });
  ok(tooMany.status === 400, `>3 operator_notes returns 400 (got ${tooMany.status})`);

  const badHours = await post(base, { ...baseScenario(), hours: baseScenario().hours.slice(0, 23) });
  ok(badHours.status === 400, `23 hours returns 400 (got ${badHours.status})`);

  const dup = baseScenario();
  dup.hours[5].hour = 4;
  const dupResp = await post(base, dup);
  ok(dupResp.status === 400, `duplicate hour returns 400 (got ${dupResp.status})`);

  const negDemand = baseScenario();
  negDemand.hours[3].demand_kwh = -10;
  const ndResp = await post(base, negDemand);
  ok([400, 422].includes(ndResp.status), `negative demand rejected (got ${ndResp.status})`);

  const badBatt = baseScenario();
  badBatt.battery.initial_energy_kwh = 500;
  const bbResp = await post(base, badBatt);
  ok([400, 422].includes(bbResp.status), `initial>capacity rejected (got ${bbResp.status})`);

  const valid = await post(base, baseScenario());
  if (valid.status === 200) {
    ok(valid.body.scenario_id === 'EDGE-BASE', 'scenario_id echoed in response');
    ok(valid.body.plan_summary && typeof valid.body.plan_summary === 'string', 'plan_summary present and string');
    ok(Array.isArray(valid.body.hourly_plan), 'hourly_plan is array');
    ok(valid.body.hourly_plan.length === 24, 'hourly_plan has 24 entries');
    ok(Array.isArray(valid.body.directive_interpretation), 'directive_interpretation is array');
    ok(valid.body.directive_interpretation.length === 1, 'one interpretation entry per note');
    ok(typeof valid.body.total_grid_kwh === 'number', 'total_grid_kwh is number');
    ok(typeof valid.body.total_cost_bdt === 'number', 'total_cost_bdt is number');
    ok(typeof valid.body.peak_grid_kwh === 'number', 'peak_grid_kwh is number');
  } else {
    ok(false, `valid request returned ${valid.status}: ${valid.raw.slice(0, 200)}`);
  }
}

async function suiteSecretSafety(base) {
  console.log('\n[SECRET SAFETY]');

  const { status, raw, body } = await post(base, baseScenario());
  ok(status === 200 || status === 500, `response is JSON-ish (status ${status})`);
  ok(!/gsk_[A-Za-z0-9]{20,}/.test(raw), 'no Groq API key pattern in response body');
  ok(!/AIza[A-Za-z0-9_-]{20,}/.test(raw), 'no Google API key pattern in response body');
  ok(!/at Object\./.test(raw), 'no V8 stack frame in response');
  ok(!/node_modules/.test(raw), 'no node_modules path in response');
  ok(!/"cause":\s*\{/.test(raw), 'no raw error cause in response');
  ok(!body.error || typeof body.error === 'string', 'error field (if any) is a string');
}

async function suiteGuardrailShapes(base) {
  console.log('\n[GUARDRAIL SHAPES]');

  const single = baseScenario({
    scenario_id: 'EDGE-SINGLE',
    operator_notes: ['No solar at all for the 14:00 hour.'],
  });
  const r1 = await post(base, single);
  if (r1.status === 200) {
    const d = r1.body.directive_interpretation[0];
    const isSolar = d.directive_type === 'solar_reduction';
    const isNoOp = d.directive_type === 'no_op';
    ok(isSolar || isNoOp, 'single-hour solar note -> solar_reduction or no_op');
    if (isSolar) {
      ok(JSON.stringify(d.structured_adjustment.hours) === JSON.stringify([14]), 'single-hour window is [14]');
      ok(approx(d.structured_adjustment.factor, 0.0, 0.01), 'no solar -> factor 0.0');
    }
  } else ok(false, `single-hour case status ${r1.status}`);

  const pct = baseScenario({
    scenario_id: 'EDGE-PCT',
    operator_notes: ['Keep at least 50% of the battery capacity stored from 6 PM until 9 PM.'],
  });
  const r2 = await post(base, pct);
  if (r2.status === 200) {
    const d = r2.body.directive_interpretation[0];
    if (d.directive_type === 'minimum_battery_reserve') {
      ok(approx(d.structured_adjustment.minimum_energy_kwh, 100, 0.5), '50% of 200kWh = 100kWh');
      ok(JSON.stringify(d.structured_adjustment.hours) === JSON.stringify([18, 19, 20]), 'hours [18,19,20]');
    } else ok(false, `50% note parsed as ${d.directive_type}`);
  } else ok(false, `pct case status ${r2.status}`);

  const red = baseScenario({
    scenario_id: 'EDGE-RED',
    operator_notes: ['Expect an 80% reduction in rooftop solar between 11 AM and 2 PM.'],
  });
  const r3 = await post(base, red);
  if (r3.status === 200) {
    const d = r3.body.directive_interpretation[0];
    if (d.directive_type === 'solar_reduction') {
      ok(approx(d.structured_adjustment.factor, 0.2, 0.01), '80% reduction -> factor 0.2');
      ok(JSON.stringify(d.structured_adjustment.hours) === JSON.stringify([11, 12, 13]), 'hours [11,12,13]');
    } else ok(false, `80% reduction parsed as ${d.directive_type}`);
  } else ok(false, `reduction case status ${r3.status}`);

  const drop = baseScenario({
    scenario_id: 'EDGE-DROP',
    operator_notes: ['Solar output will drop to about 20% from 1 PM to 3 PM.'],
  });
  const r4 = await post(base, drop);
  if (r4.status === 200) {
    const d = r4.body.directive_interpretation[0];
    if (d.directive_type === 'solar_reduction') {
      ok(approx(d.structured_adjustment.factor, 0.2, 0.01), '"drop to 20%" -> factor 0.2');
      ok(JSON.stringify(d.structured_adjustment.hours) === JSON.stringify([13, 14]), '1 PM-3 PM -> [13,14]');
    } else ok(false, `drop-to parsed as ${d.directive_type}`);
  } else ok(false, `drop case status ${r4.status}`);

  const words = baseScenario({
    scenario_id: 'EDGE-WORDS',
    operator_notes: ['Panel washing from one until three will leave roughly one-fifth of normal solar output.'],
  });
  const r5 = await post(base, words);
  if (r5.status === 200) {
    const d = r5.body.directive_interpretation[0];
    if (d.directive_type === 'solar_reduction') {
      ok(JSON.stringify(d.structured_adjustment.hours) === JSON.stringify([13, 14]), 'word-numbers -> [13,14]');
      ok(approx(d.structured_adjustment.factor, 0.2, 0.01), 'one-fifth -> 0.2');
    } else ok(false, `word-numbers parsed as ${d.directive_type} (expected solar_reduction)`);
  } else ok(false, `words case status ${r5.status}`);

  const nc = baseScenario({
    scenario_id: 'EDGE-NC',
    operator_notes: ['Do not charge the battery between 2 PM and 4 PM.'],
  });
  const r6 = await post(base, nc);
  if (r6.status === 200) {
    const d = r6.body.directive_interpretation[0];
    if (d.directive_type === 'no_charge_window') {
      ok(JSON.stringify(d.structured_adjustment.hours) === JSON.stringify([14, 15]), 'no_charge 2PM-4PM -> [14,15]');
    } else ok(false, `no-charge parsed as ${d.directive_type}`);
  } else ok(false, `no-charge case status ${r6.status}`);

  const nd = baseScenario({
    scenario_id: 'EDGE-ND',
    operator_notes: ['For protection testing, the battery must not discharge from 6 PM until 8 PM.'],
  });
  const r7 = await post(base, nd);
  if (r7.status === 200) {
    const d = r7.body.directive_interpretation[0];
    if (d.directive_type === 'no_discharge_window') {
      ok(JSON.stringify(d.structured_adjustment.hours) === JSON.stringify([18, 19]), 'no_discharge 6PM-8PM -> [18,19]');
    } else ok(false, `no-discharge parsed as ${d.directive_type}`);
  } else ok(false, `no-discharge case status ${r7.status}`);

  const mg = baseScenario({
    scenario_id: 'EDGE-MG',
    operator_notes: ['From 6 PM until 9 PM, grid import must not exceed 155 kWh in any hour.'],
  });
  const r8 = await post(base, mg);
  if (r8.status === 200) {
    const d = r8.body.directive_interpretation[0];
    if (d.directive_type === 'max_grid_window') {
      ok(JSON.stringify(d.structured_adjustment.hours) === JSON.stringify([18, 19, 20]), 'max_grid 6PM-9PM -> [18,19,20]');
      ok(approx(d.structured_adjustment.max_grid_kwh, 155, 0.5), 'max_grid 155');
    } else ok(false, `max-grid parsed as ${d.directive_type}`);
  } else ok(false, `max-grid case status ${r8.status}`);

  const noop = baseScenario({
    scenario_id: 'EDGE-NOOP',
    operator_notes: ['The cafeteria menu changes tomorrow.'],
  });
  const r9 = await post(base, noop);
  if (r9.status === 200) {
    const d = r9.body.directive_interpretation[0];
    ok(d.directive_type === 'no_op', 'distractor -> no_op');
    ok(d.applies === false, 'no_op has applies=false');
    ok(d.structured_adjustment === null, 'no_op has null adjustment');
  } else ok(false, `noop case status ${r9.status}`);
}

async function suiteDirectiveApplication(base) {
  console.log('\n[DIRECTIVE APPLICATION]');

  const solar = baseScenario({
    scenario_id: 'EDGE-SOLAR-APP',
    operator_notes: ['No solar at all from noon until 2 PM.'],
  });
  const r1 = await post(base, solar);
  if (r1.status === 200) {
    const d = r1.body.directive_interpretation[0];
    if (d.directive_type === 'solar_reduction' && d.applies) {
      const eff = solar.hours.map((h) => h.solar_kwh);
      for (const h of d.structured_adjustment.hours) {
        eff[h] = solar.hours[h].solar_kwh * d.structured_adjustment.factor;
      }
      for (let h = 0; h < 24; h++) {
        const p = r1.body.hourly_plan[h];
        ok(p.solar_used_kwh <= eff[h] + TOL, `solar cap respected at h${h} (${p.solar_used_kwh} <= ${eff[h]})`);
      }
    }
    const errs = replayPlan(solar, r1.body, null);
    ok(errs.length === 0, `replay ok (${errs.length} errs: ${errs.slice(0, 2).join('; ')})`);
  } else ok(false, `solar-app status ${r1.status}`);

  const nc = baseScenario({
    scenario_id: 'EDGE-NC-APP',
    operator_notes: ['Battery charging is disabled from 11 AM until 1 PM.'],
  });
  const r2 = await post(base, nc);
  if (r2.status === 200) {
    const d = r2.body.directive_interpretation[0];
    if (d.directive_type === 'no_charge_window' && d.applies) {
      for (const h of d.structured_adjustment.hours) {
        const p = r2.body.hourly_plan[h];
        const ch = p.battery_action === 'charge' ? p.battery_kwh : 0;
        ok(ch <= TOL, `no_charge respected at h${h} (charge=${ch})`);
      }
    }
    const errs = replayPlan(nc, r2.body, null);
    ok(errs.length === 0, `replay ok (${errs.length} errs)`);
  } else ok(false, `nc-app status ${r2.status}`);

  const nd = baseScenario({
    scenario_id: 'EDGE-ND-APP',
    operator_notes: ['Do not discharge the battery from 5 PM until 7 PM.'],
  });
  const r3 = await post(base, nd);
  if (r3.status === 200) {
    const d = r3.body.directive_interpretation[0];
    if (d.directive_type === 'no_discharge_window' && d.applies) {
      for (const h of d.structured_adjustment.hours) {
        const p = r3.body.hourly_plan[h];
        const dis = p.battery_action === 'discharge' ? p.battery_kwh : 0;
        ok(dis <= TOL, `no_discharge respected at h${h} (dis=${dis})`);
      }
    }
    const errs = replayPlan(nd, r3.body, null);
    ok(errs.length === 0, `replay ok (${errs.length} errs)`);
  } else ok(false, `nd-app status ${r3.status}`);

  const mg = baseScenario({
    scenario_id: 'EDGE-MG-APP',
    operator_notes: ['Grid intake must stay at or below 60 kWh from 6 PM until 10 PM.'],
  });
  const r4 = await post(base, mg);
  if (r4.status === 200) {
    const d = r4.body.directive_interpretation[0];
    if (d.directive_type === 'max_grid_window' && d.applies) {
      for (const h of d.structured_adjustment.hours) {
        const p = r4.body.hourly_plan[h];
        ok(p.grid_kwh <= d.structured_adjustment.max_grid_kwh + TOL, `grid cap respected at h${h} (${p.grid_kwh} <= ${d.structured_adjustment.max_grid_kwh})`);
      }
    }
    const errs = replayPlan(mg, r4.body, null);
    ok(errs.length === 0, `replay ok (${errs.length} errs)`);
  } else ok(false, `mg-app status ${r4.status} ${JSON.stringify(r4.body).slice(0, 200)}`);

  const res = baseScenario({
    scenario_id: 'EDGE-RES-APP',
    operator_notes: ['Keep at least 120 kWh in reserve from 6 PM until 9 PM.'],
  });
  const r5 = await post(base, res);
  if (r5.status === 200) {
    const d = r5.body.directive_interpretation[0];
    if (d.directive_type === 'minimum_battery_reserve' && d.applies) {
      for (const h of d.structured_adjustment.hours) {
        const p = r5.body.hourly_plan[h];
        ok(p.battery_energy_after_kwh >= d.structured_adjustment.minimum_energy_kwh - TOL, `reserve respected at h${h} (${p.battery_energy_after_kwh} >= ${d.structured_adjustment.minimum_energy_kwh})`);
      }
    }
    const errs = replayPlan(res, r5.body, null);
    ok(errs.length === 0, `replay ok (${errs.length} errs)`);
  } else ok(false, `res-app status ${r5.status}`);

  const combo = baseScenario({
    scenario_id: 'EDGE-COMBO',
    operator_notes: [
      'Keep at least 90 kWh in reserve from 6 PM until 10 PM.',
      'Grid import must not exceed 120 kWh from 7 PM until 9 PM.',
      'The library is extending hours next week.',
    ],
  });
  const r6 = await post(base, combo);
  if (r6.status === 200) {
    const errs = replayPlan(combo, r6.body, null);
    ok(errs.length === 0, `combo replay ok (${errs.length} errs: ${errs.slice(0, 2).join('; ')})`);
    ok(r6.body.directive_interpretation.length === 3, 'combo has 3 interpretation entries');
    const noops = r6.body.directive_interpretation.filter((d) => d.directive_type === 'no_op');
    ok(noops.length === 1, 'exactly one no_op in combo');
  } else ok(false, `combo status ${r6.status}`);
}

async function suiteOptimizationQuality(base) {
  console.log('\n[OPTIMIZATION QUALITY]');
  for (const c of PACK.cases) {
    const r = await post(base, c.input);
    if (r.status !== 200) {
      ok(false, `${c.id}: status ${r.status}`);
      continue;
    }
    const refCost = c.expected_output.total_cost_bdt;
    const teamCost = r.body.total_cost_bdt;
    const ratio = refCost / Math.max(1e-9, teamCost);
    ok(ratio >= 0.99, `${c.id}: cost ratio ${ratio.toFixed(4)} (>= 0.99)`);
  }
}

async function suiteReliability(base) {
  console.log('\n[RELIABILITY]');

  const scenario = baseScenario({ scenario_id: 'EDGE-REPEAT' });
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await post(base, scenario));
  ok(results.every((r) => r.status === 200), '3x identical requests all 200');
  const costs = results.map((r) => r.body.total_cost_bdt);
  ok(costs.every((c) => approx(c, costs[0], 0.01)), 'identical requests -> identical cost');

  const extreme = baseScenario({ scenario_id: 'EDGE-EXTREME', operator_notes: ['No changes.'] });
  extreme.hours.forEach((h) => (h.demand_kwh = 500));
  extreme.battery.capacity_kwh = 10;
  extreme.battery.initial_energy_kwh = 5;
  extreme.battery.minimum_energy_kwh = 1;
  extreme.battery.max_charge_kwh_per_hour = 2;
  extreme.battery.max_discharge_kwh_per_hour = 2;
  const rEx = await post(base, extreme);
  ok([200, 422].includes(rEx.status), `extreme numerics handled (${rEx.status})`);
  if (rEx.status === 200) {
    const errs = replayPlan(extreme, rEx.body, null);
    ok(errs.length === 0, `extreme replay ok (${errs.length} errs)`);
  }

  const zeros = baseScenario({ scenario_id: 'EDGE-ZERO' });
  zeros.hours.forEach((h) => {
    h.demand_kwh = 0;
    h.solar_kwh = 0;
    h.tariff_bdt_per_kwh = 0;
  });
  zeros.battery.initial_energy_kwh = 0;
  zeros.battery.minimum_energy_kwh = 0;
  const rZ = await post(base, zeros);
  ok([200, 422].includes(rZ.status), `all-zero scenario handled (${rZ.status})`);
  if (rZ.status === 200) {
    ok(approx(rZ.body.total_cost_bdt, 0, 0.01), 'all-zero cost = 0');
    ok(approx(rZ.body.total_grid_kwh, 0, 0.01), 'all-zero grid = 0');
    ok(approx(rZ.body.peak_grid_kwh, 0, 0.01), 'all-zero peak = 0');
  }

  const free = baseScenario({ scenario_id: 'EDGE-FREE' });
  free.hours.forEach((h) => (h.tariff_bdt_per_kwh = 0));
  const rFree = await post(base, free);
  if (rFree.status === 200) {
    ok(approx(rFree.body.total_cost_bdt, 0, 0.01), 'free tariff -> cost 0');
  }

  const peak = baseScenario({ scenario_id: 'EDGE-PEAK' });
  peak.hours[19].tariff_bdt_per_kwh = 1000;
  const rPeak = await post(base, peak);
  if (rPeak.status === 200) {
    const errs = replayPlan(peak, rPeak.body, null);
    ok(errs.length === 0, `peak replay ok (${errs.length} errs)`);
  }
}

async function suiteMalformedAndRecovery(base) {
  console.log('\n[MALFORMED / RECOVERY]');

  const arr = await post(base, [1, 2, 3]);
  ok(arr.status === 400, `array body -> 400 (got ${arr.status})`);

  const nul = await post(base, 'null');
  ok([400, 422].includes(nul.status), `null body -> 400/422 (got ${nul.status})`);

  const numId = await post(base, { ...baseScenario(), scenario_id: 123 });
  ok(numId.status === 400, `numeric scenario_id -> 400 (got ${numId.status})`);

  const emptyNote = await post(base, { ...baseScenario(), operator_notes: [''] });
  ok(emptyNote.status === 400, `empty note -> 400 (got ${emptyNote.status})`);

  const wsNote = await post(base, { ...baseScenario(), operator_notes: ['   '] });
  ok(wsNote.status === 400, `whitespace-only note -> 400 (got ${wsNote.status})`);

  const h24 = baseScenario();
  h24.hours[23].hour = 24;
  const r24 = await post(base, h24);
  ok(r24.status === 400, `hour=24 -> 400 (got ${r24.status})`);

  const noBatt = { ...baseScenario() };
  delete noBatt.battery;
  const rnb = await post(base, noBatt);
  ok(rnb.status === 400, `missing battery -> 400 (got ${rnb.status})`);

  const strDemand = baseScenario();
  strDemand.hours[0].demand_kwh = '100';
  const rsd = await post(base, strDemand);
  ok([400, 422].includes(rsd.status), `string demand -> 400/422 (got ${rsd.status})`);

  const nanTariff = baseScenario();
  nanTariff.hours[0].tariff_bdt_per_kwh = NaN;
  const rnt = await post(base, nanTariff);
  ok([400, 422].includes(rnt.status), `NaN tariff -> 400/422 (got ${rnt.status})`);
}

async function suiteParaphraseRobustness(base) {
  console.log('\n[PARAPHRASE ROBUSTNESS]');

  const solarCases = [
    { id: 'PARA-S1', note: 'PV production will drop to about 20% between 13:00 and 15:00.', wantHours: [13, 14], wantFactor: 0.2 },
    { id: 'PARA-S2', note: 'Panel washing from one until three will leave roughly one-fifth of normal solar output.', wantHours: [13, 14], wantFactor: 0.2 },
    { id: 'PARA-S3', note: 'Expect an 80% reduction in rooftop solar during the 1-3 PM maintenance window.', wantHours: [13, 14], wantFactor: 0.2 },
    { id: 'PARA-S4', note: 'Solar output drops to half between 10 AM and noon.', wantHours: [10, 11], wantFactor: 0.5 },
    { id: 'PARA-S5', note: 'Expect zero solar output from 2 PM until 3 PM.', wantHours: [14], wantFactor: 0.0 },
  ];
  for (const c of solarCases) {
    const s = baseScenario({ scenario_id: c.id, operator_notes: [c.note] });
    const r = await post(base, s);
    if (r.status !== 200) { ok(false, `${c.id}: status ${r.status}`); continue; }
    const d = r.body.directive_interpretation[0];
    if (d.directive_type === 'solar_reduction') {
      ok(JSON.stringify(d.structured_adjustment.hours) === JSON.stringify(c.wantHours), `${c.id}: hours ${JSON.stringify(d.structured_adjustment.hours)} == ${JSON.stringify(c.wantHours)}`);
      ok(approx(d.structured_adjustment.factor, c.wantFactor, 0.02), `${c.id}: factor ${d.structured_adjustment.factor} ~= ${c.wantFactor}`);
    } else {
      ok(false, `${c.id}: parsed as ${d.directive_type} instead of solar_reduction`);
    }
  }

  const reserveCases = [
    { id: 'PARA-R1', note: 'Keep at least 120 kWh in reserve from 6 PM until 9 PM.', want: 120, hours: [18, 19, 20] },
    { id: 'PARA-R2', note: 'Battery must stay above 120 kWh between 6 PM and 9 PM.', want: 120, hours: [18, 19, 20] },
    { id: 'PARA-R3', note: 'Ensure at least 120 kWh remains stored from 18:00 to 21:00.', want: 120, hours: [18, 19, 20] },
    { id: 'PARA-R4', note: 'Keep 50% of capacity stored from 6 PM until 9 PM.', want: 100, hours: [18, 19, 20] },
  ];
  for (const c of reserveCases) {
    const s = baseScenario({ scenario_id: c.id, operator_notes: [c.note] });
    const r = await post(base, s);
    if (r.status !== 200) { ok(false, `${c.id}: status ${r.status}`); continue; }
    const d = r.body.directive_interpretation[0];
    if (d.directive_type === 'minimum_battery_reserve') {
      ok(approx(d.structured_adjustment.minimum_energy_kwh, c.want, 1), `${c.id}: reserve ${d.structured_adjustment.minimum_energy_kwh} ~= ${c.want}`);
      ok(JSON.stringify(d.structured_adjustment.hours) === JSON.stringify(c.hours), `${c.id}: hours ${JSON.stringify(d.structured_adjustment.hours)} == ${JSON.stringify(c.hours)}`);
    } else {
      ok(false, `${c.id}: parsed as ${d.directive_type} instead of minimum_battery_reserve`);
    }
  }

  const ncCases = [
    { id: 'PARA-NC1', note: 'Do not charge the battery between 2 PM and 4 PM.', hours: [14, 15] },
    { id: 'PARA-NC2', note: 'The charger will be isolated from 14:00 to 16:00.', hours: [14, 15] },
    { id: 'PARA-NC3', note: 'Charging is disabled from 2 PM until 4 PM.', hours: [14, 15] },
  ];
  for (const c of ncCases) {
    const s = baseScenario({ scenario_id: c.id, operator_notes: [c.note] });
    const r = await post(base, s);
    if (r.status !== 200) { ok(false, `${c.id}: status ${r.status}`); continue; }
    const d = r.body.directive_interpretation[0];
    if (d.directive_type === 'no_charge_window') {
      ok(JSON.stringify(d.structured_adjustment.hours) === JSON.stringify(c.hours), `${c.id}: hours ${JSON.stringify(d.structured_adjustment.hours)} == ${JSON.stringify(c.hours)}`);
    } else {
      ok(false, `${c.id}: parsed as ${d.directive_type} instead of no_charge_window`);
    }
  }

  const ndCases = [
    { id: 'PARA-ND1', note: 'Do not discharge the battery from 6 PM until 8 PM.', hours: [18, 19] },
    { id: 'PARA-ND2', note: 'Battery must not discharge between 18:00 and 20:00.', hours: [18, 19] },
    { id: 'PARA-ND3', note: 'Discharge is disabled from 6 PM to 8 PM.', hours: [18, 19] },
  ];
  for (const c of ndCases) {
    const s = baseScenario({ scenario_id: c.id, operator_notes: [c.note] });
    const r = await post(base, s);
    if (r.status !== 200) { ok(false, `${c.id}: status ${r.status}`); continue; }
    const d = r.body.directive_interpretation[0];
    if (d.directive_type === 'no_discharge_window') {
      ok(JSON.stringify(d.structured_adjustment.hours) === JSON.stringify(c.hours), `${c.id}: hours ${JSON.stringify(d.structured_adjustment.hours)} == ${JSON.stringify(c.hours)}`);
    } else {
      ok(false, `${c.id}: parsed as ${d.directive_type} instead of no_discharge_window`);
    }
  }

  const mgCases = [
    { id: 'PARA-MG1', note: 'Grid import must not exceed 155 kWh from 6 PM until 9 PM.', cap: 155, hours: [18, 19, 20] },
    { id: 'PARA-MG2', note: 'Cap grid intake at 155 kWh between 18:00 and 21:00.', cap: 155, hours: [18, 19, 20] },
    { id: 'PARA-MG3', note: 'The feeder is limited to 155 kWh from 6 PM until 9 PM.', cap: 155, hours: [18, 19, 20] },
  ];
  for (const c of mgCases) {
    const s = baseScenario({ scenario_id: c.id, operator_notes: [c.note] });
    const r = await post(base, s);
    if (r.status !== 200) { ok(false, `${c.id}: status ${r.status}`); continue; }
    const d = r.body.directive_interpretation[0];
    if (d.directive_type === 'max_grid_window') {
      ok(JSON.stringify(d.structured_adjustment.hours) === JSON.stringify(c.hours), `${c.id}: hours ${JSON.stringify(d.structured_adjustment.hours)} == ${JSON.stringify(c.hours)}`);
      ok(approx(d.structured_adjustment.max_grid_kwh, c.cap, 1), `${c.id}: cap ${d.structured_adjustment.max_grid_kwh} ~= ${c.cap}`);
    } else {
      ok(false, `${c.id}: parsed as ${d.directive_type} instead of max_grid_window`);
    }
  }

  const noopCases = [
    { id: 'PARA-NOOP1', note: 'The library is extending book-return hours next week.' },
    { id: 'PARA-NOOP2', note: 'The student affairs office will publish club notices tomorrow.' },
    { id: 'PARA-NOOP3', note: 'A seminar room booking was moved to next week.' },
    { id: 'PARA-NOOP4', note: "The sports office moved next month's registration deadline." },
    { id: 'PARA-NOOP5', note: 'The cafeteria menu changes tomorrow.' },
  ];
  for (const c of noopCases) {
    const s = baseScenario({ scenario_id: c.id, operator_notes: [c.note] });
    const r = await post(base, s);
    if (r.status !== 200) { ok(false, `${c.id}: status ${r.status}`); continue; }
    const d = r.body.directive_interpretation[0];
    ok(d.directive_type === 'no_op', `${c.id}: distractor -> no_op (got ${d.directive_type})`);
    ok(d.applies === false, `${c.id}: no_op applies=false`);
    ok(d.structured_adjustment === null, `${c.id}: no_op adjustment null`);
  }
}

async function suiteTimeNormalization(base) {
  console.log('\n[TIME NORMALIZATION]');

  const cases = [
    { note: 'No solar from noon until 2 PM.', wantHours: [12, 13] },
    { note: 'No solar from 1 PM to 3 PM.', wantHours: [13, 14] },
    { note: 'No solar from 13:00 to 15:00.', wantHours: [13, 14] },
    { note: 'No solar from 2 AM until 5 AM.', wantHours: [2, 3, 4] },
    { note: 'No solar from 6 PM until 9 PM.', wantHours: [18, 19, 20] },
    { note: 'No solar from 11 AM until 1 PM.', wantHours: [11, 12] },
    { note: 'No solar for the 14:00 hour.', wantHours: [14] },
  ];
  for (const c of cases) {
    const s = baseScenario({ scenario_id: 'T-' + c.wantHours.join('_'), operator_notes: [c.note] });
    const r = await post(base, s);
    if (r.status !== 200) { ok(false, `${c.note}: status ${r.status}`); continue; }
    const d = r.body.directive_interpretation[0];
    if (d.directive_type === 'solar_reduction') {
      ok(JSON.stringify(d.structured_adjustment.hours) === JSON.stringify(c.wantHours), `${c.note} -> ${JSON.stringify(d.structured_adjustment.hours)} (want ${JSON.stringify(c.wantHours)})`);
    } else if (d.directive_type === 'no_op') {
      ok(false, `${c.note} -> no_op (miss)`);
    } else {
      ok(false, `${c.note} -> ${d.directive_type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
(async () => {
  let base = process.env.BASE_URL;
  let server = null;

  if (!base && USE_LOCAL) {
    const app = require('../src/app');
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  } else if (!base) {
    base = DEPLOYED_URL;
  }

  const isDeployed = !base.includes('127.0.0.1') && !base.includes('localhost');

  console.log(`Running edge-case suite against ${base}`);
  console.log(
    `Target: ${isDeployed ? 'DEPLOYED' : 'local in-process'} | ` +
      `Mode: ${process.env.GRIDWISE_FORCE_FALLBACK === '1' ? 'offline (LLM bypassed)' : 'live LLM'}` +
      `${BETWEEN_CALLS_MS > 0 ? ` | delay=${BETWEEN_CALLS_MS}ms` : ''}` +
      ` | request-timeout=${REQUEST_TIMEOUT_MS}ms`
  );

  // Warm up the deployed endpoint to avoid penalizing the first test with a cold start.
  if (isDeployed) {
    console.log('Warming up deployed endpoint (Render cold start)...');
    const t0 = Date.now();
    try {
      await get(base, '/health');
      console.log(`  warm-up took ${Date.now() - t0}ms`);
    } catch (e) {
      console.log(`  warm-up failed: ${e.message}`);
    }
    // Reset cold-start detection after warm-up (so real cold starts are flagged).
    LATENCIES.length = 0;
    COLD_START_HIT = false;
  }

  const health = await get(base, '/health');
  console.log(`Health: ${JSON.stringify(health.body)}`);

  await suiteApiContract(base);
  await suiteSecretSafety(base);
  await suiteGuardrailShapes(base);
  await suiteDirectiveApplication(base);
  await suiteOptimizationQuality(base);
  await suiteReliability(base);
  await suiteMalformedAndRecovery(base);
  await suiteParaphraseRobustness(base);
  await suiteTimeNormalization(base);

  console.log(`\n========== EDGE-CASE RESULTS ==========`);
  console.log(`PASS: ${PASS}`);
  console.log(`FAIL: ${FAIL}`);

  // Latency stats
  if (LATENCIES.length) {
    const sorted = [...LATENCIES].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
    const max = sorted[sorted.length - 1];
    console.log(`\nLatency: p50=${p50}ms  p95=${p95}ms  p99=${p99}ms  max=${max}ms  samples=${sorted.length}`);
    if (p95 > 5000) console.log(`  WARN: p95 ${p95}ms exceeds 5s — judge latency credit reduced`);
    if (p95 > 15000) console.log(`  FAIL-WARN: p95 ${p95}ms exceeds 15s — judge latency credit minimal`);
    if (p95 > 30000) console.log(`  FAIL: p95 ${p95}ms exceeds 30s — judge treats as timeout`);
  }

  // Path stats
  console.log(
    `\nInterpretation path: llm=${PATH_STATS.llm} repaired=${PATH_STATS.repaired} backup=${PATH_STATS.backup} unknown=${PATH_STATS.unknown}`
  );
  if (isDeployed && PATH_STATS.unknown > 0) {
    console.log(
      `  NOTE: ${PATH_STATS.unknown} requests had no X-Interpretation-Path header — the deployed code may predate the header addition.`
    );
  }
  if (isDeployed && PATH_STATS.backup > 0) {
    console.log(
      `  WARN: ${PATH_STATS.backup} requests fell back to the backup parser — LLM tiers are failing on the deployed endpoint.`
    );
  }

  if (FAILURES.length) {
    console.log('\nFailures:');
    FAILURES.forEach((f) => console.log('  -', f));
  }

  const code = FAIL === 0 ? 0 : 1;
  if (server) server.close(() => process.exit(code));
  else process.exit(code);
})();