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
  lines.push(`#${id}`);

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
  lines.push('All figures are estimates. Tap an entry to fix or delete it.');

  return lines.join('\n');
}

/** One stored entry opened from the /today list. */
export function formatEntryReply(row, timeLabel) {
  let items = [];
  try {
    const parsed = JSON.parse(row.items_json);
    items = Array.isArray(parsed) ? parsed : [];
  } catch {
    items = [];
  }

  const lines = [`#${row.id} · logged ${timeLabel}`];
  lines.push(...(items.length ? items.map(itemLine) : ['• (no items)']));
  lines.push('');
  lines.push(`Meal: ${macros(row)}`);
  return lines.join('\n');
}

/** /recent — the meals you log most often. DB only. */
export function formatRecentReply(repeats) {
  if (repeats.length === 0) {
    return 'Nothing logged yet. Once you have a few meals, this lists the ones you repeat so you can re-log them in one tap.';
  }
  return [
    'Your usual meals — tap one to log it again.',
    'Re-logging copies the saved numbers, so it costs nothing and is instant.',
  ].join('\n');
}

/** Button label for one repeatable meal. */
export function repeatLabel({ row, count }) {
  const times = count > 1 ? ` ×${count}` : '';
  return `🔁 ${describeRow(row)}${times}`.slice(0, 60);
}

/**
 * /export — the details needed to build the Apple Health Shortcut.
 * Sent over Telegram rather than logged, so the token never lands in Railway's
 * log stream.
 */
export function formatExportReply({ baseUrl, path, token }) {
  const url = `${baseUrl}/${path}?date=today&token=${token}`;
  return [
    'Apple Health export',
    '',
    'Tap this to check it works — you should see today\'s numbers:',
    url,
    '',
    'To sync into Apple Health: in the Shortcuts app, use "Get Contents of URL"',
    'with that exact link (no headers needed), then "Log Health Sample" for',
    'Dietary Energy, Protein, Carbohydrates and Total Fat.',
    '',
    'Swap date=today for yesterday or a date like 2026-09-01.',
    '',
    'This link only reads your food log — it cannot post to the bot or change',
    'anything. Treat it like a private link and do not share it.',
  ].join('\n');
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

/** /undo and delete-button confirmations — DB only. */
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
  'Every reply has Fix, Again and Delete buttons — tap them, no typing needed.',
  '',
  '/recent — your usual meals; tap one to re-log it free and instantly',
  '/export — URL + token for the Apple Health Shortcut',
  '/today — running total; tap any entry to fix, repeat or delete it',
  '/undo — delete the most recent entry',
  '/delete <id> — delete a specific entry',
  '/edit <id> <correction> — re-estimate an entry',
  '',
  'Every figure is an estimate. Each reply shows what I assumed so you can correct it.',
].join('\n');
