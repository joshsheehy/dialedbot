import Anthropic from '@anthropic-ai/sdk';

/**
 * The ONLY paid API surface in this bot. Reached from exactly two places:
 *   1. a Nutritionix miss on a text/restaurant message (fallback estimate)
 *   2. every photo message (there is no free vision source)
 * Each entry point makes at most one request.
 */

export const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 2048;

const SYSTEM_PROMPT = [
  'You are a nutrition estimator for a personal food log.',
  'Break the meal into individual food items and estimate calories and macros for each.',
  'Use realistic restaurant/home portion sizes and account for cooking fats and sauces.',
  'Respond with ONLY a single JSON object matching this shape, and nothing else:',
  '{"items":[{"name":string,"grams":number|null,"kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number}],',
  '"kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number,"estimated":boolean,"assumptions":string|null}',
  'The top-level kcal/protein_g/carbs_g/fat_g are the sums across items.',
  'Set "estimated" to true. Put the portion and preparation guesses you made in "assumptions"',
  '(e.g. "assumed ~6oz chicken, cooked in oil") so the user can correct you. Keep it under 200 characters.',
  'No prose, no markdown, no code fences.',
].join(' ');

// Mirrors SYSTEM_PROMPT so the API can enforce the shape server-side. If the
// endpoint rejects output_config we fall back to prompt-only + defensive
// parsing, which is why the instructions above are self-sufficient.
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          grams: { type: ['number', 'null'] },
          kcal: { type: 'number' },
          protein_g: { type: 'number' },
          carbs_g: { type: 'number' },
          fat_g: { type: 'number' },
        },
        required: ['name', 'grams', 'kcal', 'protein_g', 'carbs_g', 'fat_g'],
        additionalProperties: false,
      },
    },
    kcal: { type: 'number' },
    protein_g: { type: 'number' },
    carbs_g: { type: 'number' },
    fat_g: { type: 'number' },
    estimated: { type: 'boolean' },
    assumptions: { type: ['string', 'null'] },
  },
  required: ['items', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'estimated', 'assumptions'],
  additionalProperties: false,
};

// Set once if the account/model rejects output_config, so we never waste a
// second paid call on the same rejection twice.
let structuredOutputSupported = true;

function num(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n * 10) / 10;
}

function extractJsonObject(text) {
  let cleaned = String(text ?? '').trim();
  // Strip ```json ... ``` or ``` ... ``` fences if the model adds them anyway.
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first === -1 || last <= first) throw new Error('no JSON object found in model response');
  return JSON.parse(cleaned.slice(first, last + 1));
}

/** Coerce whatever came back into the strict shape, recomputing totals from items. */
export function normalizeResult(parsed, { forceEstimated = true } = {}) {
  const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];

  const items = rawItems
    .filter((item) => item && (item.name != null || item.kcal != null))
    .map((item) => ({
      name: String(item.name ?? 'item').slice(0, 120),
      grams: item.grams == null ? null : num(item.grams),
      kcal: num(item.kcal),
      protein_g: num(item.protein_g),
      carbs_g: num(item.carbs_g),
      fat_g: num(item.fat_g),
    }));

  // Item sums are more trustworthy than a separately-generated total; only use
  // the model's own totals when there are no items to sum.
  const totals = items.length
    ? items.reduce(
        (acc, item) => ({
          kcal: acc.kcal + item.kcal,
          protein_g: acc.protein_g + item.protein_g,
          carbs_g: acc.carbs_g + item.carbs_g,
          fat_g: acc.fat_g + item.fat_g,
        }),
        { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
      )
    : {
        kcal: num(parsed?.kcal),
        protein_g: num(parsed?.protein_g),
        carbs_g: num(parsed?.carbs_g),
        fat_g: num(parsed?.fat_g),
      };

  const assumptions =
    typeof parsed?.assumptions === 'string' && parsed.assumptions.trim()
      ? parsed.assumptions.trim().slice(0, 400)
      : null;

  return {
    items,
    kcal: num(totals.kcal),
    protein_g: num(totals.protein_g),
    carbs_g: num(totals.carbs_g),
    fat_g: num(totals.fat_g),
    estimated: forceEstimated ? true : Boolean(parsed?.estimated),
    assumptions,
  };
}

export function createLlm(apiKey) {
  const client = new Anthropic({
    apiKey,
    timeout: 60_000,
    maxRetries: 1,
  });

  async function request(content) {
    const params = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    };

    let message;
    if (structuredOutputSupported) {
      try {
        message = await client.messages.create({
          ...params,
          output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        });
      } catch (error) {
        const rejectsOutputConfig =
          error instanceof Anthropic.BadRequestError &&
          /output_config|json_schema|format/i.test(error.message ?? '');
        if (!rejectsOutputConfig) throw error;
        console.warn('[llm] output_config unsupported here; using prompt-only JSON from now on');
        structuredOutputSupported = false;
      }
    }
    if (!message) {
      message = await client.messages.create(params);
    }

    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    return normalizeResult(extractJsonObject(text));
  }

  return {
    /** Fallback for a text/restaurant description Nutritionix could not match. */
    estimateFromText(description) {
      return request([
        {
          type: 'text',
          text: `Estimate the nutrition for this meal description:\n\n${description}`,
        },
      ]);
    },

    /** Photo path: a pre-downscaled JPEG plus the optional Telegram caption. */
    estimateFromImage(jpegBuffer, caption) {
      const blocks = [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: jpegBuffer.toString('base64') },
        },
        {
          type: 'text',
          text: caption
            ? `Identify the foods in this photo, estimate the portions, and return the macros. The user added: "${caption}"`
            : 'Identify the foods in this photo, estimate the portions, and return the macros.',
        },
      ];
      return request(blocks);
    },
  };
}
