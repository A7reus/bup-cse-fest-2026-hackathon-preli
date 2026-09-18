# GridWise LLM — Smart Campus Energy Optimization

BUP CSE Fest 2026 Hackathon · Online Preliminary (GridWise LLM-assisted operator directive interpretation).

One HTTP service that: **understands operator notes with an LLM → validates with deterministic guardrails → solves minimum-cost LP dispatch → returns a judge-replayable 24h schedule.**

## Architecture

```
operator_notes ──▶ Groq gpt-oss-20b ──▶ Gemini 3.1 Flash Lite ──▶ LP optimizer ──▶ replay self-check ──▶ response
   tier chain: first     (primary)          (fallback: own          (javascript-lp-solver   (energy balance,
   guardrailed success wins                 15 RPM/500 RPD quota)   simplex, true optimum)  battery, directives)
   + one repair round-trip on tier 1 │ timeout │ deadline │ invalid JSON │ every tier fails │
                                     └─────────▶ rule-based BACKUP parser ────────┘
```

- **LLM role (mandatory, Problem Statement §02/§08):** `src/llm.js` converts each of the 1–3 notes into exactly one `{note_index, applies, directive_type, structured_adjustment, explanation}` entry in order. Tiers are tried in order — **Groq `gpt-oss-20b` → Gemini 3.1 Flash Lite** (separate quotas per provider/model) — and the first guardrailed success wins, with one repair round-trip on tier 1. A 25 s overall deadline (`LLM_DEADLINE_MS`) skips remaining tiers for backup so requests never breach the judge's 30 s limit. LLM output is **untrusted** until `src/guardrails.js` passes. Set `GRIDWISE_LLM_CHAIN` to a single tier (e.g. `gemini-lite`) for isolated per-model testing.
- **Guardrails:** allowed types only; `no_op ⇔ applies=false + null`; hours unique ints 0–23 ascending (numeric strings coerced); `solar factor 0..1` (a `20`-style percentage is repaired to `0.2`); reserve `0..capacity` (a leaked `0.5` fraction is scaled by capacity); grid cap `≥0`; start-inclusive/end-exclusive windows (`1 PM–3 PM → [13,14]`, `for the 14:00 hour → [14]`); factor = usable fraction remaining (`80% reduction → 0.2`, `no solar at all → 0.0`).
- **Backup (reliability, NOT sole interpreter):** `src/fallback.js` regex/time/percentage parser runs **only** when every LLM tier times out, errors, exhausts the deadline, or fails guardrails. The LLM chain is always attempted first (per-tier `[llm]` / `[llm:…]` log tags, `[backup]` when it serves); this keeps valid-request stability and avoids crashes (Guide §05/§08).
- **Optimizer (Optimization Quality 10 pts):** `src/optimizer.js` formulates a true linear program (minimize `Σ grid×tariff` s.t. balance, battery transitions/bounds/rates, effective solar, no-charge/discharge, reserve, grid caps, `E23 = E0`) and solves with `javascript-lp-solver` simplex — the Node equivalent of the requested PuLP+CBC optimum. Grid is recomputed from exact balance; simultaneous charge+discharge is netted; totals are rounded to 2 decimals (judge tolerance 0.01).
- **Validator:** `src/validator.js` enforces request schema (400 malformed / 422 infeasible) and replays the plan exactly like the hidden judge.

## Tech / tooling used

| Layer | Tool | Why |
|---|---|---|
| Runtime/API | Node 20 + Express 4 | Team choice; exact `/health` + `/optimize-energy` contract |
| LLM | Groq `openai/gpt-oss-20b` → Gemini 3.1 Flash Lite (`GROQ_API_KEY`, `GEMINI_API_KEY`) | ~1 s/req primary (p95 ≤ 5 s), `{"directives":[...]}` JSON mode on every tier (Llama IDs are Enterprise-only — do not use), 1 retry on 429 + 1 guardrail repair on tier 1; isolate a tier with `GRIDWISE_LLM_CHAIN` |
| Optimizer | `javascript-lp-solver` (simplex LP) | True LP optimum in Node runtime (PuLP+CBC-equivalent; PuLP needs Python, incompatible with the chosen Node stack); 1e-6 anti-cycling penalty |
| Config | `dotenv` | `GROQ_API_KEY` never committed; `.env.example` documents names |
| Deploy (live) | Render free web service | `render.yaml` + health check `/health`, binds `0.0.0.0:$PORT` |
| Fallback image | Docker Hub | `Dockerfile` (node:20-alpine, non-root user, `HEALTHCHECK`), exposes 8080, no baked secrets |
| Tests | `test/run-samples.js` | Replays all 10 public samples: interpretation vs reference, judge-style replay, totals |

## Project structure

```
.
├── src/
│   ├── app.js          # Express entry: GET /health, POST /optimize-energy, pipeline wiring
│   ├── llm.js          # Tier chain Groq→Gemini Lite with {"directives":[...]} JSON mode, 429 retry + guardrail repair
│   ├── guardrails.js   # Deterministic validation of LLM output (types, hours, numerics inc. %/fraction repair, applies semantics)
│   ├── fallback.js     # Rule-based BACKUP parser (only on LLM timeout/error/guardrail-reject)
│   ├── optimizer.js    # True LP optimum (javascript-lp-solver simplex, PuLP+CBC-equivalent)
│   └── validator.js    # Request schema checks + judge-style replay + totals recomputation
├── test/
│   ├── run-samples.js  # Replays all 10 public samples (interpretation + replay + totals)
│   ├── adversarial-cases.json  # 20 team-authored edge cases (midnight, traps, paraphrases)
│   ├── run-adversarial.js  # Harness for the adversarial pack (npm run test:adversarial)
│   └── fault-injection.js  # Dead keys/endpoints, malformed input, guardrail repairs (npm run test:faults)
├── Dockerfile          # node:20-alpine fallback image, exposes 8080, no baked secrets
├── render.yaml         # Render free web service (build/start, /health check, env names)
├── package.json        # express, javascript-lp-solver, dotenv; npm start/test
├── SCRIPT.md           # 3-minute video shooting script (tie-break preparation)
├── .env.example        # All variable names incl. GROQ/GEMINI keys, models, chain, timeouts, HOST/PORT (never commit .env)
└── BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json  # Organizer public samples (test fixture, not code)
```

## Quickstart (clean environment)

Prerequisites: **Node.js ≥ 20** (`node --version`), `npm`, `curl`. No other
runtime, database, or build tool is needed.

```bash
git clone https://github.com/A7reus/bup-cse-fest-2026-hackathon-preli
cd bup-cse-fest-hackathon-2026-hackathon-preli/hackathon-template
npm ci
cp .env.example .env   # put your GROQ_API_KEY inside (optional — see below)
npm start              # listens on 0.0.0.0:8080
```

Notes:
- The service runs **without any API key**: requests are then served by the
  deterministic backup parser (same optimizer and guardrails). Add
  `GROQ_API_KEY` (and optionally `GEMINI_API_KEY`) to `.env` for the full
  LLM path. `.env` is git-ignored and never committed.
- If port 8080 is taken, start with `PORT=18080 npm start` and replace
  `8080` with `18080` in the commands below.

Health:

```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

Optimize with a real public sample (SAMPLE-02, battery maintenance window).
This command is copy-paste runnable — it posts all 24 hours:

```bash
node -e "console.log(JSON.stringify(require('./BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json').cases[1].input))" \
  | curl -s -X POST http://localhost:8080/optimize-energy \
      -H 'Content-Type: application/json' -d @- \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s);console.log(JSON.stringify(b.directive_interpretation,null,1));console.log("cost:",b.total_cost_bdt,"grid:",b.total_grid_kwh,"peak:",b.peak_grid_kwh);})'
# Expected interpretation: no_charge_window on [2,3,4]; cost 42885, grid 2915, peak 180.
```

Public-sample test (boots the API in-process; works **without** a Groq key via backup parser, with a key via LLM):

```bash
npm test              # full chain: Groq -> Gemini Lite -> guardrails (+repair) -> LP -> replay
npm run test:offline  # quota-free: GRIDWISE_FORCE_FALLBACK=1 bypasses all LLM tiers
npm run test:faults   # fault injection: dead keys/endpoints, malformed input, guardrail repairs
npm run test:adversarial  # 20 team-authored adversarial cases (midnight windows, no-invention traps, paraphrases)
# isolated per-model runs (each must pass 10/10 on its own):
GRIDWISE_LLM_CHAIN=groq npm test
GRIDWISE_LLM_CHAIN=gemini-lite npm test
# or: BASE_URL=https://gridwise-llm-d780.onrender.com npm test
```

Expected: `10/10 samples passed` (interpretation + replay + totals). Cost ratio `ref/team` ≈ 1.0; team cost ≤ ref is fine (capped at 1.0 by the judge formula).
Other suites print their own verdicts: `20/20 adversarial cases passed.` and
`All fault-injection checks passed.` Live runs log per-request latency, and
`[backup]` tags mark any request served by the backup parser instead of a model.

## Deploying to Render (free plan)

`render.yaml` already describes the service, so dashboard setup is minimal:

1. Render Dashboard → New → Web Service → connect this repository.
2. Build command `npm ci`, start command `npm start` (both prefilled from `render.yaml`).
3. Environment tab: add `GROQ_API_KEY` (and `GEMINI_API_KEY`) as secret values;
   model/timeout defaults work unchanged.
4. Deploy, then verify **from outside your network** (phone hotspot works):
   ```bash
   curl https://<your-app>.onrender.com/health
   # {"status":"ok"}
   BASE_URL=https://<your-app>.onrender.com npm test
   ```
5. Free services sleep after ~15 min idle and wake slowly — ping
   `GET /health` every ~10 minutes (e.g. UptimeRobot free monitor) through the
   whole evaluation window so the judge never cold-starts. Re-check step 4
   after 20+ idle minutes and confirm the first response arrives well under
   30 s.

## Docker fallback

Replace `<dockerhub-user>` with your Docker Hub username throughout:

```bash
docker build -t <dockerhub-user>/gridwise-llm:1.0.0 .
docker run --rm -p 8080:8080 -e GROQ_API_KEY=$GROQ_API_KEY -e GEMINI_API_KEY=$GEMINI_API_KEY <dockerhub-user>/gridwise-llm:1.0.0
curl http://localhost:8080/health
docker push <dockerhub-user>/gridwise-llm:1.0.0
```

Submit the exact tag/digest + `docker run` command. Image contains no secrets (`grep -r GROQ_API_KEY` finds only `process.env` reads).
Judges verify with `docker pull`, the same `docker run` (keys injected via
`-e`, never baked in), and `curl http://localhost:8080/health`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `EADDRINUSE` on start | Port taken — run `PORT=18080 npm start` and use `18080` in URLs. |
| `Backup parser: …` explanations | No model key configured, or all tiers failing — intended degraded mode; add keys to `.env` for the full LLM path. |
| `429` / `tokens per day` errors in logs | Free-tier quota spent — wait for the daily reset, add spacing between requests, use `npm run test:offline` for iteration, or upgrade the provider tier. |
| Slow first response on Render | Free-service cold start — set up the 10-minute `/health` ping described above. |
| `model … does not exist` errors | Provider retired the default — set `GROQ_MODEL`/`GEMINI_MODEL` to a live ID from the provider's model list. |
| `node` version errors | Install Node.js ≥ 20 (`node --version` to check). |

## Environment variables

| Name | Required | Meaning |
|---|---|---|
| `GROQ_API_KEY` | yes for tier 1 (no for backup-tested local run) | Groq Cloud key (https://console.groq.com) |
| `GEMINI_API_KEY` | yes for tier 2 | Google AI Studio key (https://aistudio.google.com); quotas are per model |
| `GROQ_MODEL` | no (default `openai/gpt-oss-20b`) | Override if Groq retires it; any JSON-capable chat model works |
| `GEMINI_MODEL` | no (default `gemini-3.1-flash-lite`) | 15 RPM / 250K TPM / 500 RPD tier; avoid 20-RPD Flash models for judging |
| `GRIDWISE_LLM_CHAIN` | no (default `groq,gemini-lite`) | Tier order; single name isolates one tier for testing |
| `LLM_TIMEOUT_MS` | no (default `20000`) | Per-call abort timeout |
| `LLM_DEADLINE_MS` | no (default `25000`) | Overall LLM-chain budget; on expiry, remaining tiers are skipped for backup (judge fails requests past 30000 ms) |
| `LLM_MAX_ATTEMPTS` | no (default `2`) | Guardrail-driven repair round-trips before backup |
| `LLM_BASE_URL` | no (default Groq) | Custom OpenAI-compatible endpoint (gateway/proxy) |
| `GEMINI_BASE_URL` | no (default Google) | Custom endpoint for the Gemini tier |
| `GRIDWISE_FORCE_FALLBACK` | no (default `0`) | `1` bypasses all LLM tiers (quota-free `npm run test:offline` only) |
| `HOST` | no (default `0.0.0.0`) | Bind address (must stay `0.0.0.0` in containers) |
| `PORT` | no (default `8080`) | Render injects its own; app binds `0.0.0.0` |

## Known limitations

- LP assumes 100% charge/discharge efficiency and no grid export (per Problem Statement §09).
- Simultaneous charge+discharge in one hour is netted (never cost-optimal to do both).
- Backup parser handles whole-hour windows (incl. single-hour), `%`/fraction-word/`kWh` phrasing and zero-solar wording; exotic paraphrases rely on the LLM.
- If directives are mutually infeasible (organizers promise valid cases are feasible), the service returns `422` rather than an invalid plan.

## Submission checklist mapping

- `GET /health → {"status":"ok"}` ✔ · `POST /optimize-energy` exact schemas ✔
- One interpretation entry per note, ordered; `no_op ⇔ applies=false+null` ✔
- Guardrailed hours/numerics; invalid LLM output → controlled backup, never crash/invent ✔
- Plan obeys ground-truth directives + balance + solar + battery + neutrality; totals recomputed ✔
- No secrets in repo/logs/responses; `.env` git-ignored ✔
