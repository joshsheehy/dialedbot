import Anthropic from '@anthropic-ai/sdk';

/**
 * The only external API in this bot. Every logged meal costs exactly one
 * claude-haiku-4-5 call — text, restaurant, and photo alike — and /edit costs
 * one more. The DB-only paths (/today, /undo, the 21:00 summary) cost nothing.
 */

const MAX_TOKENS = 2048;

const TEXT_SYSTEM_PROMPT = [
  'You are a nutrition estimator for a personal food log.',
  'Break the meal into individual food items and give calories and macros for each.',
  '',
  'If the meal names a restaurant, chain, or packaged brand, use what you know about that',
  "item's published nutrition and say so in assumptions. If you do not know that specific",
  'item — an independent restaurant, or a dish you cannot place — estimate it from the dish',
  'description and typical preparation, and say that instead.',
  '',
  'Use realistic portion sizes and account for cooking fats, sauces, and dressings.',
  '',
  'Respond with ONLY a single JSON object matching this shape, and nothing else:',
  '{"items":[{"name":string,"grams":number|null,"kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number}],',
  '"kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number,"estimated":boolean,"assumptions":string}',
  '',
  'The top-level kcal/protein_g/carbs_g/fat_g are the sums across items.',
  'Always set "estimated" to true — every number you produce is an estimate.',
  'Always populate "assumptions" with the portion and preparation guesses you made,',
  'e.g. "assumed ~6oz cooked chicken breast, 1 tbsp oil" or "Chipotle published values, assumed',
  'white rice and no cheese". Be specific about quantities so the user can correct you.',
  'Keep it under 200 characters. Never leave it empty or null.',
  '',
  'No prose, no markdown, no code fences.',
].join(' ');

/**
 * Photos need their own system prompt. Identification is the hard part — the
 * observed failures were rice read as mashed potato and kimchi as shredded
 * carrot — so this leads with looking before naming, names the confusable
 * pairs, and demands the uncertainty be surfaced rather than hidden.
 */
const PHOTO_SYSTEM_PROMPT = [
  'You are a nutrition estimator for a personal food log, working from photographs.',
  '',
  'Work in this order:',
  '1. Describe to yourself what you actually SEE — texture, grain, colour, sheen, how it',
  '   was cut, what it is served in. Do not jump to a dish name.',
  '2. Only then decide what each food is.',
  '3. Judge portions using anything in frame that has a known size.',
  '4. Return the JSON.',
  '',
  'Identification is the part that goes wrong. Look carefully before committing:',
  '- Rice has visible separate grains; mashed potato is a smooth uniform mass; couscous',
  '  is finer and more yellow; quinoa shows tiny rings; grits and polenta are smoother.',
  '- Kimchi is irregular fermented cabbage leaf with red chilli coating, often glossy;',
  '  shredded carrot is uniform orange sticks; sauerkraut is pale and un-spiced.',
  '- Chicken, pork and turkey differ in fibre and colour; beef is darker and coarser.',
  '- Sweet potato is deeper orange than potato; cheese sauce is not hollandaise.',
  'If two foods are genuinely hard to tell apart, choose the more likely one AND say in',
  '"assumptions" what you considered and why, e.g. "grains visible, read as white rice',
  'rather than mashed potato".',
  '',
  'PORTION SIZE. Use any object in frame with a known size as a ruler:',
  '- A hand: an adult palm is about 8-9cm across and 10cm long, a closed fist about 350ml,',
  '  a thumb from knuckle to tip about 5cm.',
  '- Cutlery: a dinner fork is about 19-20cm, a teaspoon about 14cm.',
  '- Tableware: a dinner plate is about 27cm across, a side plate 20cm, a standard mug 350ml.',
  '- A soda can is 12cm tall, a credit card 8.6cm wide, a phone about 15cm.',
  'Say in "assumptions" which reference you used and the size you concluded, e.g.',
  '"hand in frame, chicken breast about 1.5 palms, ~180g".',
  'If nothing in frame gives scale, say so in "assumptions" — that is the single biggest',
  'source of error, and the user can then add a reference object and retake it.',
  '',
  'Account for cooking fats, oils, sauces and dressings you can see.',
  '',
  'Respond with ONLY a single JSON object matching this shape, and nothing else:',
  '{"items":[{"name":string,"grams":number|null,"kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number}],',
  '"kcal":number,"protein_g":number,"carbs_g":number,"fat_g":number,"estimated":boolean,"assumptions":string}',
  '',
  'The top-level kcal/protein_g/carbs_g/fat_g are the sums across items.',
  'Always set "estimated" to true.',
  '"assumptions" must cover: the scale reference used, portion sizes concluded, and any',
  'identification you were unsure about. Up to 300 characters. Never empty or null.',
  '',
  'No prose, no markdown, no code fences.',
].join('\n');

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
    // Kept nullable so a missing value degrades gracefully rather than
    // hard-failing the request; the prompt asks for it on every response.
    assumptions: { type: ['string', 'null'] },
  },
  required: ['items', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'estimated', 'assumptions'],
  additionalProperties: false,
};

// Set once if the account/model rejects output_config, so we never re-probe.
// A rejected request is not billed, so this costs nothing when it happens.
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
export function normalizeResult(parsed) {
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
    // Every number now comes from the model, so every row is an estimate.
    estimated: true,
    assumptions,
  };
}

/** Compact rendering of a previously logged meal, used as context on /edit. */
function describeItems(items) {
  if (!Array.isArray(items) || items.length === 0) return '(no items)';
  return items
    .map((item) => {
      const grams = item.grams ? `, ${item.grams}g` : '';
      return `${item.name}${grams}: ${Math.round(item.kcal)} kcal, ${Math.round(item.protein_g)}P/${Math.round(item.carbs_g)}C/${Math.round(item.fat_g)}F`;
    })
    .join('; ');
}

export function createLlm(apiKey, { textModel, photoModel }) {
  const client = new Anthropic({
    apiKey,
    timeout: 90_000,
    maxRetries: 1,
  });

  async function request(content, { model, system }) {
    const params = {
      model,
      max_tokens: MAX_TOKENS,
      system,
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
    /**
     * Modes 1 and 2. One prompt serves both: the system prompt tells the model
     * to reach for a chain's published values when it recognises the item and
     * to estimate from the description otherwise.
     */
    estimateFromText(description) {
      return request(
        [{ type: 'text', text: `Estimate the nutrition for this meal:\n\n${description}` }],
        { model: textModel, system: TEXT_SYSTEM_PROMPT },
      );
    },

    /**
     * Mode 3: one or more pre-downscaled JPEGs plus the optional caption.
     * Several photos mean several angles of ONE meal, so the prompt is explicit
     * that items visible in more than one frame must be counted once.
     */
    estimateFromImages(jpegBuffers, caption, reference) {
      const blocks = jpegBuffers.map((buffer) => ({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: buffer.toString('base64') },
      }));

      const parts = [
        jpegBuffers.length > 1
          ? `These ${jpegBuffers.length} photos are different angles of the SAME single meal. ` +
            'Identify the foods once across all of them — do NOT add up the same item twice ' +
            'because it appears in more than one photo. Use the angles together: a side-on ' +
            'view shows depth that a top-down view hides, which matters for portion size.'
          : 'Identify the foods in this photo, estimate the portions, and return the macros.',
      ];

      // The user's own measurements beat the generic averages in the system
      // prompt — their hand is a ruler of known length once it is calibrated.
      if (reference) {
        parts.push(`The user's own size references: ${reference}. Prefer these over generic averages.`);
      }

      if (caption) parts.push(`The user added: "${caption}"`);

      blocks.push({ type: 'text', text: parts.join('\n\n') });

      return request(blocks, { model: photoModel, system: PHOTO_SYSTEM_PROMPT });
    },

    /**
     * /edit. The original photo is not retained, so the previously logged items
     * stand in as context — that lets a correction like "the chicken was 8oz"
     * work against a photo entry as well as a typed one.
     */
    reestimateWithCorrection({ originalInput, previousItems, correction }) {
      return request([
        {
          type: 'text',
          text: [
            'A previously logged meal needs correcting. Re-estimate it.',
            '',
            `Originally logged from: ${originalInput || '(a photo)'}`,
            `Previous estimate: ${describeItems(previousItems)}`,
            '',
            `The user's correction: ${correction}`,
            '',
            'Apply the correction and return the full corrected meal, not just the changed part.',
          ].join('\n'),
        },
      ], { model: textModel, system: TEXT_SYSTEM_PROMPT });
    },
  };
}
