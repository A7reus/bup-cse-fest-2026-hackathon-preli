# GridWise LLM — Smart Campus Energy Optimization

BUP CSE Fest 2026 Hackathon · Online Preliminary (GridWise LLM-assisted operator directive interpretation).

One HTTP service that: **understands operator notes with an LLM → validates with deterministic guardrails → solves minimum-cost LP dispatch → returns a judge-replayable 24h schedule.**

## Architecture

```
operator_notes ──▶ Groq LLM (openai/gpt-oss-20b, JSON mode) ──▶ guardrails ──▶ LP optimizer ──▶ replay self-check ──▶ response
                     │ timeout │ invalid JSON │ guardrail reject │           (javascript-lp-solver       (energy balance,
                     └──────────▶ rule-based BACKUP parser ──────┘            simplex, true optimum)      battery, directives)
```

- **LLM role (mandatory, Problem Statement §02/§08):** `src/llm.js` converts each of the 1–3 notes into exactly one `{note_index, applies, directive_type, structured_adjustment, explanation}` entry in order. A guardrail rejection triggers **one repair round-trip** (the validator's reasons are sent back to the model) before the backup parser is used. LLM output is **untrusted** until `src/guardrails.js` passes.
- **Guardrails:** allowed types only; `no_op ⇔ applies=false + null`; hours unique ints 0–23 ascending (numeric strings coerced); `solar factor 0..1` (a `20`-style percentage is repaired to `0.2`); reserve `0..capacity` (a leaked `0.5` fraction is scaled by capacity); grid cap `≥0`; start-inclusive/end-exclusive windows (`1 PM–3 PM → [13,14]`, `for the 14:00 hour → [14]`); factor = usable fraction remaining (`80% reduction → 0.2`, `no solar at all → 0.0`).
- **Backup (reliability, NOT sole interpreter):** `src/fallback.js` regex/time/percentage parser runs **only** when the LLM times out, errors, or fails guardrails. The LLM is always attempted first (see logs `llm+backup`); this keeps valid-request stability and avoids crashes (Guide §05/§08).
- **Optimizer (Optimization Quality 10 pts):** `src/optimizer.js` formulates a true linear program (minimize `Σ grid×tariff` s.t. balance, battery transitions/bounds/rates, effective solar, no-charge/discharge, reserve, grid caps, `E23 = E0`) and solves with `javascript-lp-solver` simplex — the Node equivalent of the requested PuLP+CBC optimum. Grid is recomputed from exact balance; simultaneous charge+discharge is netted; totals are rounded to 2 decimals (judge tolerance 0.01).
- **Validator:** `src/validator.js` enforces request schema (400 malformed / 422 infeasible) and replays the plan exactly like the hidden judge.

## Tech / tooling used

| Layer | Tool | Why |
|---|---|---|
| Runtime/API | Node 20 + Express 4 | Team choice; exact `/health` + `/optimize-energy` contract |
| LLM | Groq `openai/gpt-oss-20b` via REST (`GROQ_API_KEY`) | ~1 s/req (p95 ≤ 5 s), `{"directives":[...]}` JSON mode (Llama IDs are Enterprise-only — do not use), 1 retry on 429 + 1 guardrail repair round-trip; override with `GROQ_MODEL` |
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
│   ├── llm.js          # Groq interpreter (REQUIRED primary path, {"directives":[...]} JSON mode, 429 retry + guardrail repair)
│   ├── guardrails.js   # Deterministic validation of LLM output (types, hours, numerics inc. %/fraction repair, applies semantics)
│   ├── fallback.js     # Rule-based BACKUP parser (only on LLM timeout/error/guardrail-reject)
│   ├── optimizer.js    # True LP optimum (javascript-lp-solver simplex, PuLP+CBC-equivalent)
│   └── validator.js    # Request schema checks + judge-style replay + totals recomputation
├── test/
│   └── run-samples.js  # Replays all 10 public samples (interpretation + replay + totals)
├── Dockerfile          # node:20-alpine fallback image, exposes 8080, no baked secrets
├── render.yaml         # Render free web service (build/start, /health check, env names)
├── package.json        # express, javascript-lp-solver, dotenv; npm start/test
├── .env.example        # GROQ_API_KEY, GROQ_MODEL, LLM_TIMEOUT_MS/MAX_ATTEMPTS/BASE_URL, GRIDWISE_FORCE_FALLBACK, HOST/PORT (never commit .env)
└── BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json  # Organizer public samples (test fixture, not code)
```

## Quickstart (clean environment)

```bash
npm install
cp .env.example .env   # put your GROQ_API_KEY inside
npm start              # listens on 0.0.0.0:8080
```

Health:

```bash
curl http://localhost:8080/health
# {"status":"ok"}
```

Optimize (SAMPLE-02 shape):

```bash
curl -X POST http://localhost:8080/optimize-energy \
  -H 'Content-Type: application/json' \
  -d '{"scenario_id":"SAMPLE-02","operator_notes":["The battery charger will be isolated from 2 AM until 5 AM for electrical maintenance."],"hours":[{"hour":0,"demand_kwh":100,"solar_kwh":0,"tariff_bdt_per_kwh":6}],"battery":{"capacity_kwh":200,"initial_energy_kwh":70,"minimum_energy_kwh":30,"max_charge_kwh_per_hour":55,"max_discharge_kwh_per_hour":55}}'
# NOTE: hours must contain all 24 entries 0..23 — use the full JSON from BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json
```

Public-sample test (boots the API in-process; works **without** a Groq key via backup parser, with a key via LLM):

```bash
npm test              # full path: LLM -> guardrails (+repair) -> LP -> replay
npm run test:offline  # quota-free: GRIDWISE_FORCE_FALLBACK=1 bypasses the LLM
# or: BASE_URL=https://<your-app>.onrender.com npm test
```

Expected: `10/10 samples passed` (interpretation + replay + totals). Cost ratio `ref/team` ≈ 1.0; team cost ≤ ref is fine (capped at 1.0 by the judge formula).

## Docker fallback

```bash
docker build -t <dockerhub-user>/gridwise-llm:1.0.0 .
docker run --rm -p 8080:8080 -e GROQ_API_KEY=$GROQ_API_KEY <dockerhub-user>/gridwise-llm:1.0.0
curl http://localhost:8080/health
docker push <dockerhub-user>/gridwise-llm:1.0.0
```

Submit the exact tag/digest + `docker run` command. Image contains no secrets (`grep -r GROQ_API_KEY` finds only `process.env` reads).

## Environment variables

| Name | Required | Meaning |
|---|---|---|
| `GROQ_API_KEY` | yes for LLM path (no for backup-tested local run) | Groq Cloud key (https://console.groq.com) |
| `GROQ_MODEL` | no (default `openai/gpt-oss-20b`) | Override if Groq retires it; any JSON-capable chat model works |
| `LLM_TIMEOUT_MS` | no (default `20000`) | Must keep total `/optimize-energy` < 30000 ms |
| `LLM_MAX_ATTEMPTS` | no (default `2`) | Guardrail-driven repair round-trips before backup |
| `LLM_BASE_URL` | no (default Groq) | Custom OpenAI-compatible endpoint (gateway/proxy) |
| `GRIDWISE_FORCE_FALLBACK` | no (default `0`) | `1` bypasses the LLM (quota-free `npm run test:offline` only) |
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
