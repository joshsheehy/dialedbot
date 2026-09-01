import cron from 'node-cron';
import { localDayRange, formatLocalDate } from './time.js';
import { formatDailySummary } from './format.js';

/**
 * The 21:00 daily summary, scheduled in-process — no separate Railway cron
 * service. node-cron evaluates the expression against config.timeZone, so
 * changing TZ moves the summary with you.
 *
 * DB only: computing and sending this never costs an API call.
 */
export function startDailySummary({ bot, queries, config }) {
  const task = cron.schedule(
    config.summaryCron,
    async () => {
      try {
        const now = new Date();
        const { start, end } = localDayRange(config.timeZone, now);
        const totals = queries.totalsForRange(config.authorizedChatId, start, end);
        const text = formatDailySummary(totals, formatLocalDate(config.timeZone, now));
        await bot.api.sendMessage(config.authorizedChatId, text);
      } catch (error) {
        console.error('[summary] failed to send daily summary:', error);
      }
    },
    // node-cron v4 starts the task on creation; noOverlap guards against a
    // second firing while a slow Telegram send is still in flight.
    { timezone: config.timeZone, name: 'daily-summary', noOverlap: true },
  );

  console.log(`[summary] scheduled "${config.summaryCron}" in ${config.timeZone}`);
  return task;
}
