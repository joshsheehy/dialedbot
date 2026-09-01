/**
 * Repeat detection. Grouping happens in JS rather than SQL so the food_log
 * schema stays unchanged — a personal log is small enough that scanning the
 * recent rows costs nothing.
 */

/** Rows scanned when looking for repeats. Well beyond a year of normal logging. */
export const LOOKBACK_ROWS = 400;

function parseItems(row) {
  try {
    const parsed = JSON.parse(row.items_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Identity of a meal for repeat purposes: its item names, normalised and
 * sorted. Portion corrections change the numbers but not the dish, so
 * "chicken + rice" logged at 200g and at 227g count as the same meal — you
 * still get the most recent version's exact macros when you re-log it.
 */
export function mealSignature(row) {
  const names = parseItems(row)
    .map((item) => String(item.name ?? '').toLowerCase().trim())
    .filter(Boolean)
    .sort();

  if (names.length) return names.join('|');
  const fallback = String(row.raw_input ?? '').toLowerCase().trim().split('\n')[0];
  return fallback || null;
}

/**
 * Collapse rows into distinct meals, most-repeated first.
 *
 * @param rows newest-first, so the first row seen for a signature is also the
 *   most recent — that is the one re-logging copies.
 */
export function groupRepeats(rows, limit = 10) {
  const bySignature = new Map();

  for (const row of rows) {
    const signature = mealSignature(row);
    if (!signature) continue;

    const seen = bySignature.get(signature);
    if (seen) {
      seen.count += 1;
    } else {
      bySignature.set(signature, { row, count: 1 });
    }
  }

  return [...bySignature.values()]
    .sort((a, b) => b.count - a.count || b.row.ts - a.row.ts)
    .slice(0, limit);
}
