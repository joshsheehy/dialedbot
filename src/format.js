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

/** Reply sent immediately after a meal is logged. */
export function formatMealReply({ result, totals }) {
  const lines = [];

  if (result.items.length) {
    lines.push(...result.items.map(itemLine));
  } else {
    lines.push('• (no items identified)');
  }

  lines.push('');
  lines.push(`Meal: ${macros(result)}${result.estimated ? '  (estimated)' : ''}`);

  if (result.estimated && result.assumptions) {
    lines.push(`Assumed: ${result.assumptions}`);
  }

  lines.push(`Today: ${macros(totals)} · ${totals.meals} ${totals.meals === 1 ? 'meal' : 'meals'}`);
  return lines.join('\n');
}

/** /today */
export function formatTodayReply(totals, dateLabel) {
  if (totals.meals === 0) return `${dateLabel} — nothing logged yet today.`;
  const lines = [
    `${dateLabel}`,
    `${macros(totals)}`,
    `${totals.meals} ${totals.meals === 1 ? 'meal' : 'meals'} logged`,
  ];
  if (totals.estimatedCount > 0) {
    lines.push(`${totals.estimatedCount} of them estimated`);
  }
  return lines.join('\n');
}

/** 21:00 cron message. */
export function formatDailySummary(totals, dateLabel) {
  if (totals.meals === 0) return `Daily summary — ${dateLabel}\nNo meals logged today.`;
  const lines = [
    `Daily summary — ${dateLabel}`,
    '',
    `Total: ${n(totals.kcal)} kcal`,
    `Protein: ${n(totals.protein_g)}g`,
    `Carbs:   ${n(totals.carbs_g)}g`,
    `Fat:     ${n(totals.fat_g)}g`,
    '',
    `${totals.meals} ${totals.meals === 1 ? 'meal' : 'meals'} logged`,
  ];
  if (totals.estimatedCount > 0) {
    const plural = totals.estimatedCount === 1 ? 'entry was an estimate' : 'entries were estimates';
    lines.push(`Note: ${totals.estimatedCount} ${plural}.`);
  }
  return lines.join('\n');
}

/** /undo */
export function formatUndoReply(row, timeLabel, totals) {
  let items = [];
  try {
    items = JSON.parse(row.items_json);
  } catch {
    items = [];
  }
  const names = items.map((item) => item.name).join(', ') || row.raw_input || '(entry)';
  return [
    `Deleted: ${names}`,
    `Was ${macros(row)} at ${timeLabel}`,
    `Today: ${macros(totals)} · ${totals.meals} ${totals.meals === 1 ? 'meal' : 'meals'}`,
  ].join('\n');
}

export const HELP_TEXT = [
  'Send me what you ate and I will log it.',
  '',
  'Text — "200g chicken breast and a cup of white rice"',
  'Restaurant — "chicken bowl from Chipotle with rice, black beans, guac"',
  'Photo — send a picture of the meal (add a caption for extra detail)',
  '',
  '/today — running total for today',
  '/undo — delete the most recent entry',
].join('\n');
