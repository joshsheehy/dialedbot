import { lookupNutrition } from './nutritionix.js';
import { downscaleToJpeg } from './image.js';

/**
 * ROUTING — this is where the money is spent (or not).
 *
 *   TEXT / RESTAURANT   Nutritionix (free) -> on a miss, ONE claude-haiku-4-5 call
 *   PHOTO               downscale -> ONE claude-haiku-4-5 call (always paid)
 *
 * There is no path in this file that makes more than one paid call, and no
 * path that calls the model when Nutritionix already answered.
 */

/**
 * Free, local classifier for the `source` column — never costs a call.
 * A branded Nutritionix hit is definitive; otherwise fall back to the phrasing
 * ("... from Chipotle", "... at Panera").
 */
function classifySource(text, branded) {
  if (branded) return 'restaurant';
  return /\b(?:from|at)\s+[A-Za-z]/i.test(text ?? '') ? 'restaurant' : 'text';
}

export function createAnalyzer({ llm, config }) {
  const nutritionixCreds = {
    appId: config.nutritionixAppId,
    apiKey: config.nutritionixApiKey,
    timeZone: config.timeZone,
  };

  return {
    /** Modes 1 and 2 — identical routing, they only differ in the stored `source`. */
    async analyzeText(text) {
      // STEP 1 (FREE): Nutritionix natural-language nutrients. Covers generic
      // foods and chain-restaurant items alike.
      const matched = await lookupNutrition(text, nutritionixCreds);
      if (matched) {
        const { branded, ...result } = matched;
        return { ...result, source: classifySource(text, branded) };
      }

      // STEP 2 (PAID — exactly one call): only reached when Nutritionix had
      // nothing usable, e.g. an independent restaurant with no published data.
      const estimated = await llm.estimateFromText(text);
      return { ...estimated, source: classifySource(text, false) };
    },

    /** Mode 3 — the one path that always spends a paid call. */
    async analyzePhoto(imageBuffer, caption) {
      // Shrink first so we pay for ~768px of vision tokens, not the original.
      const jpeg = await downscaleToJpeg(imageBuffer);
      // PAID — exactly one call.
      const estimated = await llm.estimateFromImage(jpeg, caption);
      return { ...estimated, source: 'photo' };
    },
  };
}
