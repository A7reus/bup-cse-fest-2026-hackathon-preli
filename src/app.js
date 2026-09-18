/**
 * GridWise LLM service — Express entry point.
 * Architecture: LLM chain (groq -> gemini-lite) -> guardrails -> LP optimizer -> replay check
 * Endpoints: GET /health, POST /optimize-energy (exact names per Problem Statement Sec 06)
 */
require('dotenv').config();
const express = require('express');
const llm = require('./llm');
const { guardAll } = require('./guardrails');
const { fallbackInterpret } = require('./fallback');
const { optimize } = require('./optimizer');
const { validateRequest, replayCheck, computeTotals } = require('./validator');

const FORCE_FALLBACK = process.env.GRIDWISE_FORCE_FALLBACK === '1';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});


app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/optimize-energy', async (req, res) => {
  const hardTimeout = setTimeout(() => {
    if (!res.headersSent) {
      console.error('[timeout] request exceeded 28s budget');
      res.status(500).json({ error: 'Request timeout' });
    }
  }, 28000);

  try {
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

    let interpretation = null;
    let servedByTier = 'backup';
    const useBackup = (why) => {
      interpretation = fallbackInterpret(operator_notes, battery);
      servedByTier = 'backup';
      console.warn(`[backup] serving via backup parser (${why})`);
    };

    const DEADLINE_MS = parseInt(process.env.LLM_DEADLINE_MS || '25000', 10);
    const chainStarted = Date.now();
    const budgetLeft = () => DEADLINE_MS - (Date.now() - chainStarted);
    const failReason = (e) => `${e.provider || 'llm'}: ${String(e.message).slice(0, 200)}`;

    if (FORCE_FALLBACK) {
      useBackup('backup(forced-offline)');
    } else {
      const providers = llm.getProviders();
      const requested = llm.getChain();
      const chain = requested.filter((t) => providers[t] && providers[t].apiKey);
      const skipped = requested.filter((t) => !providers[t] || !providers[t].apiKey);
      if (skipped.length) {
        console.warn(`[chain] skipping tiers with no API key: ${skipped.join(', ')}`);
      }

      if (!chain.length) {
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
            raw = await llm.interpretWithProvider(tier, operator_notes, battery);
          } catch (e) {
            tierIssues.push(failReason(e));
            const causeStr = e.cause ? ` (cause: ${e.cause.code || e.cause.message})` : '';
            console.warn(
              `[${tag}] ${e.code || 'ERROR'}: ${String(e.message).slice(0, 200)}${causeStr}`
            );
            continue;
          }

          let g = guardAll(raw, operator_notes.length, battery);
          if (g.ok) {
            interpretation = g.entries;
            servedByTier = tier;
            break;
          }

          if (
            ti === 0 &&
            llm.MAX_ATTEMPTS > 1 &&
            isRecoverable(g.reason) &&
            budgetLeft() > 0
          ) {
            try {
              console.warn(`[${tag}] guardrail rejected (${g.reason}); asking model to repair`);
              raw = await llm.repairWithProvider(tier, operator_notes, battery, raw, g.reason);
              g = guardAll(raw, operator_notes.length, battery);
            } catch (e) {
              tierIssues.push(failReason(e));
              console.warn(
                `[${tag}/repair] ${e.code || 'ERROR'}: ${String(e.message).slice(0, 200)}`
              );
            }
            if (g.ok) {
              interpretation = g.entries;
              servedByTier = `${tier}(repaired)`;
              console.warn(`[${tag}] repaired output accepted`);
              break;
            }
          }
          tierIssues.push(`${label}: guardrail rejected (${g.reason})`);
          console.warn(`[${tag}] guardrail rejected (${g.reason}); trying next tier`);
        }

        if (!interpretation) {
          console.warn(`[chain] all tiers failed (${tierIssues.join(' | ')}); using backup parser`);
          useBackup('llm+backup');
        }
      }
    }

    res.setHeader('X-Interpretation-Path', servedByTier);

    let plan, eff;
    try {
      const out = optimize(hours, battery, interpretation);
      plan = out.plan;
      eff = out.eff;
    } catch (e) {
      console.error(`[optimizer] ${e.message}`);
      return res
        .status(422)
        .json({ error: 'No feasible schedule under the interpreted directives' });
    }

    const check = replayCheck(hours, battery, interpretation, plan, eff);
    if (!check.ok) {
      console.error(`[replay] self-check failed: ${check.reason}`);
      return res.status(500).json({ error: 'Internal scheduling error' });
    }

    const totals = computeTotals(hours, plan);
    const summary = buildSummary(interpretation, totals, servedByTier);

    return res.status(200).json({
      scenario_id,
      directive_interpretation: interpretation,
      hourly_plan: plan,
      total_grid_kwh: totals.total_grid_kwh,
      total_cost_bdt: totals.total_cost_bdt,
      peak_grid_kwh: totals.peak_grid_kwh,
      plan_summary: summary,
    });
  } finally {
    clearTimeout(hardTimeout);
  }
});

function buildSummary(interpretation, totals, servedByTier) {
  const parts = interpretation.map((d) => {
    if (d.directive_type === 'no_op') return 'ignores an unrelated note';
    if (d.directive_type === 'solar_reduction')
      return `applies solar factor ${d.structured_adjustment.factor} on [${d.structured_adjustment.hours.join(',')}]`;
    if (d.directive_type === 'minimum_battery_reserve')
      return `holds reserve ${d.structured_adjustment.minimum_energy_kwh} kWh on [${d.structured_adjustment.hours.join(',')}]`;
    if (d.directive_type === 'max_grid_window')
      return `caps grid at ${d.structured_adjustment.max_grid_kwh} kWh on [${d.structured_adjustment.hours.join(',')}]`;
    return `${d.directive_type} on [${d.structured_adjustment.hours.join(',')}]`;
  });
  const readBy =
    servedByTier === 'backup'
      ? 'Interpreted (backup parser)'
      : `LLM-interpreted (${servedByTier})`;
  return `${readBy} ${interpretation.length} note(s) (${parts.join('; ')}), solved minimum-cost LP dispatch (grid ${totals.total_grid_kwh} kWh, cost BDT ${totals.total_cost_bdt}), restored end-of-day battery neutrality.`;
}

function isRecoverable(reason) {
  return /expected \d+ entries|invalid hours|must be 0\.\.1|must be 0\.\.capacity|note_index mismatch|missing structured_adjustment/i.test(
    reason || ''
  );
}

app.use((req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

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
    const providers = llm.getProviders();
    const requested = llm.getChain();
    const active =
      requested
        .filter((t) => providers[t] && providers[t].apiKey)
        .map((t) => providers[t].label)
        .join(' > ') || 'NONE (backup parser only)';
    console.log(`GridWise LLM listening on ${HOST}:${PORT}`);
    console.log(`  providers: ${active}`);
    console.log(
      `  model:     groq=${providers.groq.model}  gemini=${providers['gemini-lite'].model}`
    );
    console.log(`  force-fallback=${FORCE_FALLBACK}`);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

module.exports = app;