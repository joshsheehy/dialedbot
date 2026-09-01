function n(value) {
  const num = Number(value) || 0;
  return Math.round(num).toLocaleString('en-US');
}

function macros(totals) {
  return `${n(totals.kcal)} kcal · ${n(totals.protein_g)}P / ${n(totals.carbs_g)}C / ${n(totals.fat_g)}F`;
}

function itemLine(item) {
  const grams = item.grams ? ` — ${n(item.grams)}g` : '';
  return `• ${item.name}${grams}: ${macros(item)}`;
}

function mealCount(count) {
  return `${count} ${count === 1 ? 'meal' : 'meals'}`;
}

/**
 * Every number now comes from the model, so "estimated" is a given rather than
 * a per-meal tag. What is worth showing on every reply is the assumptions line
 * — that is what /edit acts on.
 */
function assumptionLine(result) {
  return `Assumed: ${result.assumptions ?? 'portions estimated from the description'}`;
}

function parseItems(row) {
  try {
    const items = JSON.parse(row.items_json);
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

/** Short label for a stored row, e.g. "Chicken breast, White rice". */
export function describeRow(row) {
  const names = parseItems(row).map((item) => item.name);
  if (names.length) return names.join(', ');
  return row.raw_input?.split('\n')[0] || '(entry)';
}

/** Reply sent immediately after a meal is logged. */
export function formatMealReply({ id, result, totals }) {
  const lines = [];

  if (result.items.length) {
    lines.push(...result.items.map(itemLine));
  } else {
    lines.push('• (no items identified)');
  }

  lines.push('');
  lines.push(`Meal: ${macros(result)}`);
  lines.push(assumptionLine(result));
  lines.push(`Today: ${macros(totals)} · ${mealCount(totals.meals)}`);
  lines.push('');
  // The id is what makes /edit usable — surface it where a bad estimate is
  // most likely to be noticed.
  lines.push(`#${id} · wrong portion? /edit ${id} <correction>`);

  return lines.join('\n');
}

/** Reply after /edit succeeds. */
export function formatEditReply({ id, result, totals }) {
  const lines = [`Updated #${id}:`];

  if (result.items.length) {
    lines.push(...result.items.map(itemLine));
  } else {
    lines.push('• (no items identified)');
  }

  lines.push('');
  lines.push(`Meal: ${macros(result)}`);
  lines.push(assumptionLine(result));
  lines.push(`Today: ${macros(totals)} · ${mealCount(totals.meals)}`);

  return lines.join('\n');
}

/** /today — DB only. Lists ids so older entries can be corrected too. */
export function formatTodayReply(totals, entries, dateLabel) {
  if (totals.meals === 0) return `${dateLabel} — nothing logged yet today.`;

  const lines = [
    dateLabel,
    `${macros(totals)}`,
    `${mealCount(totals.meals)} logged`,
    '',
  ];

  for (const row of entries) {
    lines.push(`#${row.id} · ${describeRow(row)} — ${n(row.kcal)} kcal`);
  }

  lines.push('');
  lines.push('All figures are estimates. Correct one with /edit <id> <correction>.');

  return lines.join('\n');
}

/** 21:00 cron message — DB only. */
export function formatDailySummary(totals, dateLabel) {
  if (totals.meals === 0) return `Daily summary — ${dateLabel}\nNo meals logged today.`;

  return [
    `Daily summary — ${dateLabel}`,
    '',
    `Total: ${n(totals.kcal)} kcal`,
    `Protein: ${n(totals.protein_g)}g`,
    `Carbs:   ${n(totals.carbs_g)}g`,
    `Fat:     ${n(totals.fat_g)}g`,
    '',
    `${mealCount(totals.meals)} logged`,
    'All figures are estimates.',
  ].join('\n');
}

/** /undo — DB only. */
export function formatUndoReply(row, timeLabel, totals) {
  return [
    `Deleted #${row.id}: ${describeRow(row)}`,
    `Was ${macros(row)} at ${timeLabel}`,
    `Today: ${macros(totals)} · ${mealCount(totals.meals)}`,
  ].join('\n');
}

export const HELP_TEXT = [
  'Send me what you ate and I will log it.',
  '',
  'Text — "200g chicken breast and a cup of white rice"',
  'Restaurant — "chicken bowl from Chipotle with rice, black beans, guac"',
  'Photo — send a picture of the meal (add a caption for extra detail)',
  '',
  '/today — running total, with entry ids',
  '/edit <id> <correction> — re-estimate an entry, e.g. /edit 42 the chicken was 8oz',
  '/undo — delete the most recent entry',
  '',
  'Every figure is an estimate. Each reply shows what I assumed so you can correct it.',
].join('\n');
