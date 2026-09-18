/**
 * Fault-injection checks for the failure paths unit/integration tests can't
 * reach: dead provider keys, unreachable endpoints, malformed input, and the
 * guardrail repair helpers. Every case must end in a controlled 200/400/404 —
 * never a crash, hang, or secret leak.
 *
 * Usage: npm run test:faults   (no API quota used; all LLM calls fail fast)
 */
const fs = require('fs');
const path = require('path');

const PACK = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json'), 'utf8')
);

// Point every tier at unusable credentials/endpoints BEFORE the app loads.
process.env.GROQ_API_KEY = 'invalid-key-for-fault-test';
delete process.env.GEMINI_API_KEY;
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/nope';
process.env.GEMINI_BASE_URL = 'http://127.0.0.1:9/nope';
process.env.LLM_TIMEOUT_MS = '4000';
process.env.LLM_DEADLINE_MS = '12000';

const { guardAll } = require('../src/guardrails');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  PASS ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

(async () => {
  const app = require('../src/app');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, raw) =>
    fetch(`${base}/optimize-energy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw !== undefined ? raw : JSON.stringify(body),
    });

  console.log('fault: unreachable provider endpoints (expect 200 via backup)');
  {
    const c = PACK.cases[1]; // single no_charge_window note
    const t0 = Date.now();
    const res = await post(c.input);
    const body = await res.json();
    const ms = Date.now() - t0;
    check('HTTP 200', res.status === 200, `got ${res.status}`);
    check('valid interpretation', Array.isArray(body.directive_interpretation) && body.directive_interpretation.length === 1);
    check('backup served it', (body.directive_interpretation[0].explanation || '').startsWith('Backup parser'));
    check('summary is honest', (body.plan_summary || '').startsWith('Interpreted (backup parser)'));
    check('cost optimal', body.total_cost_bdt === c.expected_output.total_cost_bdt, `got ${body.total_cost_bdt}`);
    check('under deadline', ms < 12000, `${ms}ms`);
    const leaked = JSON.stringify(body).includes('invalid-key-for-fault-test');
    check('no secret leak', !leaked);
  }

  console.log('fault: malformed JSON (expect 400)');
  {
    const res = await post(null, '{oops');
    check('HTTP 400', res.status === 400, `got ${res.status}`);
  }

  console.log('fault: empty object (expect 400)');
  {
    const res = await post({});
    check('HTTP 400', res.status === 400, `got ${res.status}`);
  }

  console.log('fault: unknown endpoint (expect 404)');
  {
    const res = await fetch(`${base}/nope`);
    check('HTTP 404', res.status === 404, `got ${res.status}`);
  }

  console.log('unit: guardrail repairs (no model needed)');
  {
    const batt = { capacity_kwh: 200 };
    const pct = guardAll(
      [{ note_index: 0, applies: true, directive_type: 'solar_reduction', structured_adjustment: { hours: [12, 13], factor: 20 }, explanation: 'x' }],
      1, batt
    );
    check('factor 20 -> 0.2', pct.ok && pct.entries[0].structured_adjustment.factor === 0.2, JSON.stringify(pct));
    const frac = guardAll(
      [{ note_index: 0, applies: true, directive_type: 'minimum_battery_reserve', structured_adjustment: { hours: [18], minimum_energy_kwh: 0.5 }, explanation: 'x' }],
      1, batt
    );
    check('reserve 0.5 -> 100 kWh', frac.ok && frac.entries[0].structured_adjustment.minimum_energy_kwh === 100, JSON.stringify(frac));
    const strs = guardAll(
      [{ note_index: 0, applies: true, directive_type: 'no_charge_window', structured_adjustment: { hours: ['2', 3, '4'] }, explanation: 'x' }],
      1, batt
    );
    check('string hours coerced', strs.ok && JSON.stringify(strs.entries[0].structured_adjustment.hours) === '[2,3,4]', JSON.stringify(strs));
    const bad = guardAll(
      [{ note_index: 0, applies: true, directive_type: 'solar_reduction', structured_adjustment: { hours: [12], factor: 2 }, explanation: 'x' }],
      1, batt
    );
    check('factor 2 -> 0.02 (percent repair)', bad.ok && bad.entries[0].structured_adjustment.factor === 0.02, JSON.stringify(bad));
    const absurd = guardAll(
      [{ note_index: 0, applies: true, directive_type: 'solar_reduction', structured_adjustment: { hours: [12], factor: 150 }, explanation: 'x' }],
      1, batt
    );
    check('factor 150 still rejected', !absurd.ok, JSON.stringify(absurd));
    const neg = guardAll(
      [{ note_index: 0, applies: true, directive_type: 'solar_reduction', structured_adjustment: { hours: [12], factor: -0.5 }, explanation: 'x' }],
      1, batt
    );
    check('negative factor rejected', !neg.ok, JSON.stringify(neg));
  }

  console.log(failures === 0 ? '\nAll fault-injection checks passed.' : `\n${failures} fault-injection check(s) FAILED.`);
  server.close(() => process.exit(failures === 0 ? 0 : 1));
})().catch((e) => {
  console.error('harness error:', e.message);
  process.exit(1);
});
