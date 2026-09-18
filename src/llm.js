/**
 * Groq LLM interpreter for operator_notes (+ Gemini fallback tier).
 *
 * CONTRACT (Problem Statement Sec 04/05/08):
 * - Every operator note -> exactly one directive entry, note_index order.
 * - Allowed directive_type: solar_reduction, minimum_battery_reserve,
 *   no_charge_window, no_discharge_window, max_grid_window, no_op
 * - For no_op: applies=false, structured_adjustment=null
 * - For others: applies=true + exact shape
 * - hours: unique ints 0..23 ascending, start-inclusive / end-exclusive
 *   e.g. "1 PM to 3 PM" -> [13,14]
 * - solar factor = usable fraction remaining (80% reduction -> 0.2)
 *
 * CHAIN (in order): Groq gpt-oss-20b (primary) -> Gemini 3.1 Flash Lite
 * (fallback, separate quota). The fallback tier serves only when the
 * primary errors, times out, or fails guardrails (after one repair
 * round-trip on the primary). Rule-based fallback (src/fallback.js) is
 * ONLY a backup when every tier fails — never the sole interpreter.
 */

const ALLOWED_TYPES = new Set([
  'solar_reduction',
  'minimum_battery_reserve',
  'no_charge_window',
  'no_discharge_window',
  'max_grid_window',
  'no_op',
]);

const DEFAULT_GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const DEFAULT_GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-20b';
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
const TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '20000', 10);
const MAX_ATTEMPTS = Math.max(1, parseInt(process.env.LLM_MAX_ATTEMPTS || '2', 10));

/** Tier definitions, in fallback order (quotas are tracked per model). Env is read live so tests can re-point tiers per request. */
function getProviders() {
  return {
    groq: {
      label: 'groq', url: process.env.LLM_BASE_URL || DEFAULT_GROQ_URL,
      apiKey: process.env.GROQ_API_KEY || '', model: DEFAULT_GROQ_MODEL,
    },
    'gemini-lite': {
      label: 'gemini-3.1-flash-lite', url: process.env.GEMINI_BASE_URL || DEFAULT_GEMINI_URL,
      apiKey: process.env.GEMINI_API_KEY || '', model: DEFAULT_GEMINI_MODEL,
    },
  };
}

/**
 * Chain order. Default: groq -> gemini-lite.
 * Override for isolated per-model testing, e.g. GRIDWISE_LLM_CHAIN=gemini-lite.
 */
function getChain() {
  const providers = getProviders();
  const raw = (process.env.GRIDWISE_LLM_CHAIN || 'groq,gemini-lite').split(',');
  const chain = [];
  for (const name of raw) {
    const key = name.trim().toLowerCase();
    if (providers[key] && !chain.includes(key)) chain.push(key);
  }
  return chain.length ? chain : ['groq', 'gemini-lite'];
}

function buildSystemPrompt(battery) {
  return `You interpret campus energy operator notes into strict JSON directives.

Allowed directive_type values (only these):
- solar_reduction: {"hours":[...], "factor": number 0..1}
- minimum_battery_reserve: {"hours":[...], "minimum_energy_kwh": number}
- no_charge_window: {"hours":[...]}
- no_discharge_window: {"hours":[...]}
- max_grid_window: {"hours":[...], "max_grid_kwh": number}
- no_op: null adjustment (note is irrelevant to the 24h energy schedule)

Rules:
1. Return a JSON ARRAY with EXACTLY one object per input note, in input order (if given 1 note, return 1 object; if 3 notes, return 3). Never add, merge, or split notes.
2. Each object: {"note_index": i, "applies": bool, "directive_type": str, "structured_adjustment": obj|null, "explanation": str}
3. Relevant note -> applies=true. Irrelevant note (cafeteria menu, library hours, registration deadlines, club notices, seminar bookings, sports office, etc.) -> applies=false, directive_type="no_op", structured_adjustment=null.
4. Hours are whole-hour intervals, start-inclusive end-exclusive, unique ints 0..23 ascending.
   Examples: "1 PM to 3 PM" -> [13,14]; "noon until 2 PM" -> [12,13]; "2 AM until 5 AM" -> [2,3,4]; "6 PM until 9 PM" -> [18,19,20]; "6 PM until 10 PM" -> [18,19,20,21]; "11 AM until 1 PM" -> [11,12]; "13:00 to 15:00" -> [13,14]; "11 PM until midnight" -> [23]; "for the 14:00 hour" -> [14]; "midnight" is 0, "noon" is 12.
5. solar_reduction factor = usable fraction REMAINING (0..1). "80% reduction" -> 0.2. "drop to about 20%" -> 0.2. "roughly 25% of forecast" -> 0.25. "about half" -> 0.5. "one-fifth" -> 0.2. "no solar at all" -> 0.0.
6. minimum_battery_reserve: "Keep at least 120 kWh" -> 120. "50% of battery capacity" with capacity ${battery.capacity_kwh} kWh -> ${battery.capacity_kwh / 2}. Must be >=0 and <= capacity (${battery.capacity_kwh}).
7. max_grid_window: "must not exceed 155 kWh" -> 155. Non-negative.
8. no_charge_window / no_discharge_window have ONLY hours, no numeric field.
9. Do NOT invent demand/solar/tariff/battery values. Do NOT invent new directive types.
10. Output ONLY a JSON OBJECT of the form {"directives": [...]}, no markdown, no commentary.

Battery context: capacity=${battery.capacity_kwh} kWh.`;
}

function buildUserPrompt(notes) {
  const lines = notes.map((n, i) => `Note ${i}: ${n}`);
  return `There are EXACTLY ${notes.length} note(s). Return {"directives": [...]} with EXACTLY ${notes.length} object(s), one per note, with note_index 0..${notes.length - 1} in order. Do NOT add extra objects.\n${lines.join('\n')}\n\nReturn ONLY the JSON object.`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REPAIR_HINT = `Your previous reply was rejected by the deterministic validator. Issues: {{ISSUES}}. Return corrected JSON only. Remember: one entry per note in order, hours ascending unique ints 0-23, end hour excluded, solar factor = fraction remaining (0-1), reserve in absolute kWh.`;

/**
 * OpenAI-compatible chat call with JSON mode.
 * Retries once on 429 honoring retry-after (free-tier TPM caps).
 * Throws on missing key, timeout, non-200, or bad JSON.
 * `extraMessages` appends to the conversation (used for guardrail repair).
 */
async function callChat(provider, notes, battery, retried = false, extraMessages = []) {
  if (!provider.apiKey) {
    const err = new Error(`${provider.label}: API key is not set`);
    err.code = 'NO_API_KEY';
    err.provider = provider.label;
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(provider.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildSystemPrompt(battery) },
          { role: 'user', content: buildUserPrompt(notes) },
          ...extraMessages,
        ],
        max_tokens: 1200,
      }),
    });

    if (res.status === 429 && !retried) {
      const text = await res.text().catch(() => '');
      const m = text.match(/try again in ([\d.]+)s/i);
      const waitMs = Math.min(m ? parseFloat(m[1]) * 1000 : 3000, 8000);
      clearTimeout(timer);
      await sleep(waitMs);
      return callChat(provider, notes, battery, true, extraMessages);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`${provider.label} HTTP ${res.status}: ${text.slice(0, 300)}`);
      err.code = 'PROVIDER_HTTP';
      err.status = res.status;
      err.provider = provider.label;
      throw err;
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      const err = new Error(`${provider.label} returned empty content`);
      err.code = 'PROVIDER_EMPTY';
      err.provider = provider.label;
      throw err;
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

// Backward-compatible Groq-only entry points (primary tier).
async function callGroq(notes, battery, retried = false, extraMessages = []) {
  return callChat(getProviders().groq, notes, battery, retried, extraMessages);
}

/** Extract directives array from JSON-mode object response. */
function extractJsonArray(text) {
  // Strip markdown fences some models add despite "no markdown" instructions.
  const stripped = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  // Direct parse first
  const pick = (parsed) => {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      // Prefer the documented wrapper key (avoids grabbing a nested hours array)
      if (Array.isArray(parsed.directives)) return parsed.directives;
      // Fallback: first array whose items look like directive objects
      for (const v of Object.values(parsed)) {
        if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] !== null && 'directive_type' in v[0]) return v;
      }
      // Last resort: first array value (legacy)
      for (const v of Object.values(parsed)) {
        if (Array.isArray(v)) return v;
      }
    }
    throw new Error('LLM JSON is not an array');
  };
  try {
    return pick(JSON.parse(stripped));
  } catch (e) {
    // Try to find bracketed object substring
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return pick(JSON.parse(stripped.slice(start, end + 1)));
    }
    throw e;
  }
}

/**
 * Interpret notes via one chain tier.
 * Returns raw parsed array (unguarded — caller must run guardrails).
 */
async function interpretWithProvider(tier, notes, battery) {
  const provider = getProviders()[tier];
  if (!provider) {
    const err = new Error(`unknown LLM tier "${tier}"`);
    err.code = 'NO_TIER';
    throw err;
  }
  const raw = await callChat(provider, notes, battery);
  return extractJsonArray(raw);
}

/**
 * Guardrail-driven repair on one tier: re-ask the same model with the
 * validator's rejection reasons. Only for recoverable rejections —
 * never for provider errors. Returns raw array; caller re-validates.
 */
async function repairWithProvider(tier, notes, battery, badEntries, reason) {
  const provider = getProviders()[tier];
  const extra = [
    { role: 'assistant', content: JSON.stringify({ directives: badEntries }) },
    { role: 'user', content: REPAIR_HINT.replace('{{ISSUES}}', reason) },
  ];
  const raw = await callChat(provider, notes, battery, false, extra);
  return extractJsonArray(raw);
}

/** Primary-tier (Groq) shorthands kept for compatibility. */
async function interpretWithLLM(notes, battery) {
  return interpretWithProvider('groq', notes, battery);
}
async function repairWithLLM(notes, battery, badEntries, reason) {
  return repairWithProvider('groq', notes, battery, badEntries, reason);
}

module.exports = {
  ALLOWED_TYPES,
  interpretWithLLM,
  repairWithLLM,
  interpretWithProvider,
  repairWithProvider,
  getProviders,
  getChain,
  buildSystemPrompt,
  extractJsonArray,
  MAX_ATTEMPTS,
  REPAIR_HINT,
};
