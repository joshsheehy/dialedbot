import { downscaleToJpeg } from './image.js';

/**
 * ROUTING — every logged meal costs exactly ONE claude-haiku-4-5 call.
 *
 *   TEXT        -> one call
 *   RESTAURANT  -> one call (same prompt; the model reaches for the chain's
 *                  published values when it knows the item, and estimates from
 *                  the description when it does not)
 *   PHOTO       -> downscale to 768px, then one vision call
 *   EDIT        -> one call, re-estimating an existing row from a correction
 *
 * No path here makes more than one call. /today, /undo and the daily summary
 * never reach this module at all.
 */

/**
 * Free, local classifier for the `source` column — never costs a call.
 * Distinguishes "200g chicken breast" from "chicken bowl from Chipotle" on
 * phrasing alone.
 */
function classifySource(text) {
  return /\b(?:from|at)\s+[A-Za-z]/i.test(text ?? '') ? 'restaurant' : 'text';
}

export function createAnalyzer({ llm }) {
  return {
    /** Modes 1 and 2 — identical routing, they only differ in the stored `source`. */
    async analyzeText(text) {
      const result = await llm.estimateFromText(text); // PAID — exactly one call
      return { ...result, source: classifySource(text) };
    },

    /** Mode 3. */
    async analyzePhoto(imageBuffer, caption) {
      // Shrink first so we pay for ~768px of vision tokens, not the original.
      const jpeg = await downscaleToJpeg(imageBuffer);
      const result = await llm.estimateFromImage(jpeg, caption); // PAID — exactly one call
      return { ...result, source: 'photo' };
    },

    /**
     * /edit. The row keeps its original `source` and timestamp — a correction
     * changes the numbers, not when the meal happened or how it was captured.
     */
    async analyzeCorrection({ originalInput, previousItems, correction }) {
      // PAID — exactly one call.
      return llm.reestimateWithCorrection({ originalInput, previousItems, correction });
    },
  };
}
