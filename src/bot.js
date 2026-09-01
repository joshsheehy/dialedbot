import { Bot } from 'grammy';
import { pickPhotoSize } from './image.js';
import { localDayRange, formatLocalDate, formatLocalTime } from './time.js';
import {
  formatMealReply,
  formatEditReply,
  formatTodayReply,
  formatUndoReply,
  describeRow,
  HELP_TEXT,
} from './format.js';

const FRIENDLY_ERROR =
  "Sorry — I couldn't work that one out. Try rephrasing it, or send it again in a moment.";

// Keeps raw_input bounded when an entry is corrected repeatedly.
const MAX_RAW_INPUT = 2000;

async function downloadTelegramFile(ctx, fileId, token) {
  const file = await ctx.api.getFile(fileId);
  const response = await fetch(
    `https://api.telegram.org/file/bot${token}/${file.file_path}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) throw new Error(`Telegram file download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export function createBot({ config, queries, analyzer }) {
  const bot = new Bot(config.telegramBotToken);

  const today = () => {
    const { start, end } = localDayRange(config.timeZone);
    return {
      totals: queries.totalsForRange(config.authorizedChatId, start, end),
      entries: queries.entriesForRange(config.authorizedChatId, start, end),
    };
  };

  // The bot token is publicly reachable, so gate everything on the one chat ID
  // we care about. Anyone else is dropped without a reply.
  bot.use(async (ctx, next) => {
    if (String(ctx.chat?.id ?? '') !== String(config.authorizedChatId)) return;
    await next();
  });

  bot.command(['start', 'help'], (ctx) => ctx.reply(HELP_TEXT));

  // DB only — no API call.
  bot.command('today', async (ctx) => {
    const { totals, entries } = today();
    await ctx.reply(formatTodayReply(totals, entries, formatLocalDate(config.timeZone)));
  });

  // DB only — no API call.
  bot.command('undo', async (ctx) => {
    const row = queries.deleteLatest(config.authorizedChatId);
    if (!row) {
      await ctx.reply('Nothing to undo — the log is empty.');
      return;
    }
    await ctx.reply(
      formatUndoReply(row, formatLocalTime(config.timeZone, new Date(row.ts)), today().totals),
    );
  });

  // /edit <id> <correction> — costs ONE paid call, like logging a meal.
  bot.command('edit', async (ctx) => {
    const argument = (ctx.match ?? '').trim();
    const match = argument.match(/^(\d+)\s+(.+)$/s);
    if (!match) {
      await ctx.reply(
        'Usage: /edit <id> <correction>\nFor example: /edit 42 the chicken was 8oz, no oil\nRun /today to see entry ids.',
      );
      return;
    }

    const id = Number(match[1]);
    const correction = match[2].trim();

    const row = queries.getEntry(config.authorizedChatId, id);
    if (!row) {
      await ctx.reply(`No entry #${id}. Run /today to see current ids.`);
      return;
    }

    await ctx.replyWithChatAction('typing').catch(() => {});
    try {
      let previousItems = [];
      try {
        previousItems = JSON.parse(row.items_json);
      } catch {
        previousItems = [];
      }

      const result = await analyzer.analyzeCorrection({
        originalInput: row.raw_input,
        previousItems,
        correction,
      });

      // Keep the correction history so a second /edit on the same row still has
      // the full picture to work from.
      const rawInput = `${row.raw_input ?? ''}\n↳ ${correction}`.trim().slice(-MAX_RAW_INPUT);
      queries.updateEntry({ id, rawInput, result });

      await ctx.reply(formatEditReply({ id, result, totals: today().totals }));
    } catch (error) {
      console.error('[bot] edit failed:', error);
      await ctx.reply(`${FRIENDLY_ERROR}\n#${id} is unchanged: ${describeRow(row)}`);
    }
  });

  /** Persist an analysed meal and reply with it plus the running daily total. */
  async function logAndReply(ctx, result, rawInput) {
    const id = queries.addEntry({
      chatId: config.authorizedChatId,
      ts: Date.now(),
      source: result.source,
      rawInput,
      result,
    });
    await ctx.reply(formatMealReply({ id, result, totals: today().totals }));
  }

  // Modes 1 and 2: one paid claude-haiku-4-5 call.
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith('/')) return;

    await ctx.replyWithChatAction('typing').catch(() => {});
    try {
      const result = await analyzer.analyzeText(text);
      await logAndReply(ctx, result, text);
    } catch (error) {
      console.error('[bot] text analysis failed:', error);
      await ctx.reply(FRIENDLY_ERROR);
    }
  });

  // Mode 3: downscale, then one paid claude-haiku-4-5 vision call.
  bot.on('message:photo', async (ctx) => {
    await ctx.replyWithChatAction('typing').catch(() => {});
    try {
      const size = pickPhotoSize(ctx.message.photo);
      const buffer = await downloadTelegramFile(ctx, size.file_id, config.telegramBotToken);
      const caption = ctx.message.caption?.trim() || null;
      const result = await analyzer.analyzePhoto(buffer, caption);
      await logAndReply(ctx, result, caption ?? '(photo)');
    } catch (error) {
      console.error('[bot] photo analysis failed:', error);
      await ctx.reply(FRIENDLY_ERROR);
    }
  });

  // Anything else (voice, video, stickers, documents) — no API call, just a nudge.
  bot.on('message', async (ctx) => {
    await ctx.reply('I can read text descriptions and photos of meals. Send me one of those.');
  });

  // Last line of defence: a handler throwing must never take the process down.
  bot.catch((err) => {
    console.error('[bot] unhandled error:', err.error ?? err);
  });

  return bot;
}
