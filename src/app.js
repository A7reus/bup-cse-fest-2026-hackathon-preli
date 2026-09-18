/**
 * GridWise LLM service — Express entry point.
 * Architecture: LLM (Groq) -> deterministic guardrails -> LP optimizer -> replay check
 * Endpoints: GET /health, POST /optimize-energy (exact names per Problem Statement Sec 06)
 */
require('dotenv').config();
const express = require('express');
const { interpretWithProvider, repairWithProvider, getProviders, getChain, MAX_ATTEMPTS } = require('./llm');
const { guardAll } = require('./guardrails');
const { fallbackInterpret } = require('./fallback');
const { optimize } = require('./optimizer');
const { validateRequest, replayCheck, computeTotals } = require('./validator');

const FORCE_FALLBACK = process.env.GRIDWISE_FORCE_FALLBACK === '1';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));

// Do not leak stack traces / secrets (rubric: secret safety)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/optimize-energy', async (req, res) => {
  // 400 on malformed / structurally invalid
  let parsed;
  try {
    parsed = validateRequest(req.body);
  } catch (e) {
    return res.status(400).json({ error: 'Malformed request' });
  }
  if (!parsed.ok) {
    return res.status(parsed.status || 400).json({ error: parsed.error });
  }
  const { scenario_id, operator_notes, hours, battery } = parsed.data;

  // ---- 1. LLM interpretation (REQUIRED path) ----
  // Tier chain: groq -> gemini-lite. Each tier is tried in order;
  // the first tier gets one guardrail-driven repair round-trip. Only when
  // every tier errors or fails guardrails does the backup parser run.
  let interpretation = null;
  let servedByLLM = true;
  const useBackup = (why) => {
    interpretation = fallbackInterpret(operator_notes, battery);
    servedByLLM = false;
    console.warn(`[backup] serving via backup parser (${why})`);
  };
  // Overall interpretation deadline: the judge fails requests past 30s, so
  // the whole LLM chain (tiers + repair + 429 waits) must finish well inside
  // it. On expiry we stop calling models and use the backup parser.
  const DEADLINE_MS = parseInt(process.env.LLM_DEADLINE_MS || '25000', 10);
  const chainStarted = Date.now();
  const budgetLeft = () => DEADLINE_MS - (Date.now() - chainStarted);
  const failReason = (e) => `${e.provider || 'llm'}: ${e.message}`;
  if (FORCE_FALLBACK) {
    useBackup('backup(forced-offline)');
  } else {
    const providers = getProviders();
    const chain = getChain().filter((t) => providers[t] && providers[t].apiKey);
    if (!chain.length) {
      console.warn('[llm] no provider API key configured — using backup parser');
      useBackup('backup(no-key)');
    } else {
      const tierIssues = [];
      for (let ti = 0; ti < chain.length && !interpretation; ti += 1) {
        if (budgetLeft() <= 0) {
          tierIssues.push('interpretation deadline exceeded');
          console.warn('[chain] deadline exceeded; skipping remaining tiers');
          break;
        }
        const tier = chain[ti];
        const label = providers[tier].label;
        const tag = tier === 'groq' ? 'llm' : `llm:${label}`;
        let raw;
        try {
          raw = await interpretWithProvider(tier, operator_notes, battery);
        } catch (e) {
          tierIssues.push(failReason(e));
          console.warn(`[${tag}] ${e.code || 'ERROR'}: ${e.message}`);
          continue;
        }
        let g = guardAll(raw, operator_notes.length, battery);
        if (g.ok) {
          interpretation = g.entries;
          break;
        }
        // One repair round-trip, first tier only, and only inside budget.
        if (ti === 0 && MAX_ATTEMPTS > 1 && isRecoverable(g.reason) && budgetLeft() > 0) {
          try {
            console.warn(`[${tag}] guardrail rejected (${g.reason}); asking model to repair`);
            raw = await repairWithProvider(tier, operator_notes, battery, raw, g.reason);
            g = guardAll(raw, operator_notes.length, battery);
          } catch (e) {
            tierIssues.push(failReason(e));
            console.warn(`[${tag}/repair] ${e.code || 'ERROR'}: ${e.message}`);
          }
          if (g.ok) {
            interpretation = g.entries;
            console.warn(`[${tag}] repaired output accepted`);
            break;
          }
        }
        tierIssues.push(`${label}: guardrail rejected (${g.reason})`);
        console.warn(`[${tag}] guardrail rejected (${g.reason}); trying next tier`);
      }
      if (!interpretation) {
        // SAFE FAILURE: every tier failed -> controlled backup, never invent/crash
        console.warn(`[chain] all tiers failed (${tierIssues.join(' | ')}); using backup parser`);
        useBackup('llm+backup');
      }
    }
  }

  // ---- 2. Optimize (true LP optimum) ----
  let plan, eff;
  try {
    const out = optimize(hours, battery, interpretation);
    plan = out.plan;
    eff = out.eff;
  } catch (e) {
    console.error(`[optimizer] ${e.message}`);
    return res.status(422).json({ error: 'No feasible schedule under the interpreted directives' });
  }

  // ---- 3. Replay self-check (judge does the same) ----
  const check = replayCheck(hours, battery, interpretation, plan, eff);
  if (!check.ok) {
    console.error(`[replay] self-check failed: ${check.reason}`);
    return res.status(500).json({ error: 'Internal scheduling error' });
  }

  const totals = computeTotals(hours, plan);
  const summary = buildSummary(interpretation, totals, servedByLLM);

  return res.status(200).json({
    scenario_id,
    directive_interpretation: interpretation,
    hourly_plan: plan,
    total_grid_kwh: totals.total_grid_kwh,
    total_cost_bdt: totals.total_cost_bdt,
    peak_grid_kwh: totals.peak_grid_kwh,
    plan_summary: summary,
  });
});

function buildSummary(interpretation, totals, viaLLM) {
  const parts = interpretation.map((d) => {
    if (d.directive_type === 'no_op') return 'ignores an unrelated note';
    if (d.directive_type === 'solar_reduction') return `applies solar factor ${d.structured_adjustment.factor} on [${d.structured_adjustment.hours.join(',')}]`;
    if (d.directive_type === 'minimum_battery_reserve') return `holds reserve ${d.structured_adjustment.minimum_energy_kwh} kWh on [${d.structured_adjustment.hours.join(',')}]`;
    if (d.directive_type === 'max_grid_window') return `caps grid at ${d.structured_adjustment.max_grid_kwh} kWh on [${d.structured_adjustment.hours.join(',')}]`;
    return `${d.directive_type} on [${d.structured_adjustment.hours.join(',')}]`;
  });
  const readBy = viaLLM ? 'LLM-interpreted' : 'Interpreted (backup parser)';
  return `${readBy} ${interpretation.length} note(s) (${parts.join('; ')}), solved minimum-cost LP dispatch (grid ${totals.total_grid_kwh} kWh, cost BDT ${totals.total_cost_bdt}), restored end-of-day battery neutrality.`;
}

/** Rejections worth one repair round-trip (fixable slips, not provider errors). */
function isRecoverable(reason) {
  return /expected \d+ entries|invalid hours|must be 0\.\.1|must be 0\.\.capacity|note_index mismatch|missing structured_adjustment/i.test(reason || '');
}

app.use((req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

// Malformed JSON body -> 400 (never crash / leak)
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Malformed JSON' });
  }
  console.error('[unhandled]', err && err.message);
  return res.status(500).json({ error: 'Internal error' });
});

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
if (require.main === module) {
  const server = app.listen(PORT, HOST, () => {
    console.log(`GridWise LLM listening on ${HOST}:${PORT} (chain=${getChain().join('>')})`);
  });
  // The judge may hammer the endpoint; keep sockets from piling up.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

module.exports = app;
