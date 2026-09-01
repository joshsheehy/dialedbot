/**
 * Nutritionix natural-language nutrients endpoint.
 *
 * This is the FREE path and it is tried FIRST for every text message. Its
 * database covers both generic foods ("200g chicken breast") and branded /
 * restaurant items ("chicken bowl from Chipotle"), so a single call serves the
 * TEXT and RESTAURANT modes. A miss here — and only a miss — escalates to the
 * paid model.
 */

const ENDPOINT = 'https://trackapi.nutritionix.com/v2/natural/nutrients';
const TIMEOUT_MS = 15_000;

function round(value, places = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** places;
  return Math.round(n * factor) / factor;
}

function titleCase(text) {
  return String(text).replace(/\b\w/g, (c) => c.toUpperCase());
}

function describeServing(food) {
  const qty = food.serving_qty;
  const unit = food.serving_unit;
  if (qty == null || !unit) return null;
  return `${round(qty, 2)} ${unit}`;
}

/**
 * @returns {Promise<null | {items: Array, kcal: number, protein_g: number,
 *   carbs_g: number, fat_g: number, estimated: false, assumptions: null,
 *   branded: boolean}>} null means "no usable match" — the caller should fall back.
 */
export async function lookupNutrition(query, { appId, apiKey, timeZone }) {
  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-app-id': appId,
        'x-app-key': apiKey,
        'x-remote-user-id': '0',
      },
      body: JSON.stringify({ query, timezone: timeZone }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error('[nutritionix] request failed:', error.message);
    return null;
  }

  // 404 is Nutritionix's "we could not match any food in that sentence".
  if (response.status === 404) return null;
  if (!response.ok) {
    console.error(`[nutritionix] HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return null;
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    console.error('[nutritionix] unparseable response:', error.message);
    return null;
  }

  const foods = Array.isArray(data?.foods) ? data.foods : [];
  if (foods.length === 0) return null;

  const items = foods.map((food) => {
    const serving = describeServing(food);
    const brand = food.brand_name ? `${food.brand_name} ` : '';
    const name = `${brand}${titleCase(food.food_name ?? 'food')}`;
    return {
      name: serving ? `${name} (${serving})` : name,
      grams: food.serving_weight_grams == null ? null : round(food.serving_weight_grams),
      kcal: round(food.nf_calories),
      protein_g: round(food.nf_protein),
      carbs_g: round(food.nf_total_carbohydrate),
      fat_g: round(food.nf_total_fat),
    };
  });

  const totals = items.reduce(
    (acc, item) => ({
      kcal: acc.kcal + item.kcal,
      protein_g: acc.protein_g + item.protein_g,
      carbs_g: acc.carbs_g + item.carbs_g,
      fat_g: acc.fat_g + item.fat_g,
    }),
    { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  );

  // A match with zero calories is not usable data — treat it as a miss.
  if (totals.kcal <= 0) return null;

  return {
    items,
    kcal: round(totals.kcal),
    protein_g: round(totals.protein_g),
    carbs_g: round(totals.carbs_g),
    fat_g: round(totals.fat_g),
    estimated: false,
    assumptions: null,
    // True when at least one match came from the branded/restaurant database.
    branded: foods.some((food) => Boolean(food.brand_name)),
  };
}
