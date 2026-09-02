import { Bot, InlineKeyboard } from 'grammy';
import { pickPhotoSize } from './image.js';
import { localDayRange, formatLocalDate, formatLocalTime } from './time.js';
import {
  formatMealReply,
  formatEditReply,
  formatTodayReply,
  formatEntryReply,
  formatUndoReply,
  formatRecentReply,
  formatExportReply,
  repeatLabel,
  describeRow,
  HELP_TEXT,
} from './format.js';
import { groupRepeats, LOOKBACK_ROWS } from './repeats.js';

const FRIENDLY_ERROR =
  "Sorry — I couldn't work that one out. Try rephrasing it, or send it again in a moment.";

// Keeps raw_input bounded when an entry is corrected repeatedly.
const MAX_RAW_INPUT = 2000;

/**
 * Telegram has no "album" update: sending several photos at once delivers one
 * message per photo, all sharing a media_group_id, arriving milliseconds apart.
 * Buffer them and fire once the group goes quiet, so several angles of one meal
 * become one entry and one paid call instead of one of each per photo.
 */
const ALBUM_SETTLE_MS = 2000;

// The Fix button asks a question carrying the entry id. The user's reply to it
// is routed as a correction instead of a new meal, so ids never need typing.
const FIX_PROMPT = (id, label) => `Correcting #${id} — ${label}\n\nWhat should I change?`;
const FIX_PROMPT_RE = /^Correcting #(\d+) —/;

/**
 * Buttons attached to a single entry. Delete sits on its own row so it is not
 * a neighbour of the two buttons you actually press often.
 */
const entryKeyboard = (id) =>
  new InlineKeyboard()
    .text('✏️ Fix', `fix:${id}`)
    .text('🔁 Again', `again:${id}`)
    .row()
    .text('🗑 Delete', `del:${id}`);

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

  const timeOf = (row) => formatLocalTime(config.timeZone, new Date(row.ts));

  // The bot token is publicly reachable, so gate everything on the one chat ID
  // we care about. Anyone else is dropped without a reply. This covers button
  // taps too — ctx.chat is set for callback queries as well as messages.
  const loggedUnknownChats = new Set();
  bot.use(async (ctx, next) => {
    const chatId = String(ctx.chat?.id ?? '');
    if (chatId !== String(config.authorizedChatId)) {
      if (chatId && !loggedUnknownChats.has(chatId)) {
        loggedUnknownChats.add(chatId);
        console.warn(
          `[bot] ignored a message from chat ${chatId} (AUTHORIZED_CHAT_ID is ${config.authorizedChatId}). ` +
            'If that chat is you, set AUTHORIZED_CHAT_ID to it and redeploy.',
        );
      }
      return;
    }
    await next();
  });

  bot.command(['start', 'help'], (ctx) => ctx.reply(HELP_TEXT));

  // ---- DB-only commands (no API call) ------------------------------------

  bot.command('today', async (ctx) => {
    const { totals, entries } = today();
    // One button per entry so any of them can be reached, not just the last.
    // .row() goes BETWEEN buttons — calling it after the last one leaves an
    // empty row in the markup.
    const keyboard = new InlineKeyboard();
    entries.forEach((row, index) => {
      if (index > 0) keyboard.row();
      keyboard.text(`#${row.id} ${describeRow(row)}`.slice(0, 60), `show:${row.id}`);
    });
    await ctx.reply(formatTodayReply(totals, entries, formatLocalDate(config.timeZone)), {
      reply_markup: entries.length ? keyboard : undefined,
    });
  });

  // Re-logging copies a stored row, so this whole path costs NOTHING — no
  // Nutritionix, no model call. Most meals repeat, so this is the cheapest and
  // fastest way to log.
  bot.command('recent', async (ctx) => {
    const repeats = groupRepeats(
      queries.recentRows(config.authorizedChatId, LOOKBACK_ROWS),
    );
    const keyboard = new InlineKeyboard();
    repeats.forEach((entry, index) => {
      if (index > 0) keyboard.row();
      keyboard.text(repeatLabel(entry), `again:${entry.row.id}`);
    });
    await ctx.reply(formatRecentReply(repeats), {
      reply_markup: repeats.length ? keyboard : undefined,
    });
  });

  // Hands over the Apple Health export credentials. Delivered here rather than
  // logged, since Railway's log stream is the wrong place for a token.
  bot.command('export', async (ctx) => {
    if (!config.publicUrl) {
      await ctx.reply('No public URL is configured yet, so there is nothing to export from.');
      return;
    }
    await ctx.reply(
      formatExportReply({
        baseUrl: config.publicUrl,
        path: config.exportPath,
        token: config.exportToken,
      }),
    );
  });

  bot.command('undo', async (ctx) => {
    const row = queries.deleteLatest(config.authorizedChatId);
    if (!row) {
      await ctx.reply('Nothing to undo — the log is empty.');
      return;
    }
    await ctx.reply(formatUndoReply(row, timeOf(row), today().totals));
  });

  bot.command('delete', async (ctx) => {
    const id = Number((ctx.match ?? '').trim());
    if (!Number.isInteger(id) || id < 1) {
      await ctx.reply('Usage: /delete <id>\nRun /today to see entry ids, or tap 🗑 on any reply.');
      return;
    }
    const row = queries.deleteEntry(config.authorizedChatId, id);
    if (!row) {
      await ctx.reply(`No entry #${id}. Run /today to see current ids.`);
      return;
    }
    await ctx.reply(formatUndoReply(row, timeOf(row), today().totals));
  });

  // ---- Corrections (ONE paid call) ---------------------------------------

  /** Shared by /edit and by a reply to a Fix prompt. */
  async function applyCorrection(ctx, id, correction) {
    const row = queries.getEntry(config.authorizedChatId, id);
    if (!row) {
      await ctx.reply(`No entry #${id}. Run /today to see current ids.`);
      return;
    }

    await ctx.replyWithChatAction('typing').catch(() => {});
    try {
      let previousItems = [];
      try {
        const parsed = JSON.parse(row.items_json);
        previousItems = Array.isArray(parsed) ? parsed : [];
      } catch {
        previousItems = [];
      }

      const result = await analyzer.analyzeCorrection({
        originalInput: row.raw_input,
        previousItems,
        correction,
      });

      // Keep the correction history so a second fix on the same row still has
      // the full picture to work from.
      const rawInput = `${row.raw_input ?? ''}\n↳ ${correction}`.trim().slice(-MAX_RAW_INPUT);
      queries.updateEntry({ id, rawInput, result });

      await ctx.reply(formatEditReply({ id, result, totals: today().totals }), {
        reply_markup: entryKeyboard(id),
      });
    } catch (error) {
      console.error('[bot] correction failed:', error);
      await ctx.reply(`${FRIENDLY_ERROR}\n#${id} is unchanged: ${describeRow(row)}`);
    }
  }

  bot.command('edit', async (ctx) => {
    const match = (ctx.match ?? '').trim().match(/^(\d+)\s+(.+)$/s);
    if (!match) {
      await ctx.reply(
        'Usage: /edit <id> <correction>\nFor example: /edit 42 the chicken was 8oz\n\nEasier: tap ✏️ Fix on any reply, or run /today and tap an entry.',
      );
      return;
    }
    await applyCorrection(ctx, Number(match[1]), match[2].trim());
  });

  // ---- Button taps --------------------------------------------------------

  bot.on('callback_query:data', async (ctx) => {
    const [action, rawId] = ctx.callbackQuery.data.split(':');
    const id = Number(rawId);

    if (!Number.isInteger(id)) {
      await ctx.answerCallbackQuery();
      return;
    }

    if (action === 'del') {
      const row = queries.deleteEntry(config.authorizedChatId, id);
      await ctx.answerCallbackQuery({ text: row ? `Deleted #${id}` : `#${id} is already gone` });
      if (row) {
        const { totals } = today();
        // Rewrite the original message so the log reads correctly on scrollback.
        await ctx
          .editMessageText(formatUndoReply(row, timeOf(row), totals))
          .catch(() => ctx.reply(formatUndoReply(row, timeOf(row), totals)));
      }
      return;
    }

    if (action === 'fix') {
      const row = queries.getEntry(config.authorizedChatId, id);
      if (!row) {
        await ctx.answerCallbackQuery({ text: `#${id} is gone` });
        return;
      }
      await ctx.answerCallbackQuery();
      // force_reply pre-aims the keyboard at this prompt, so the next thing
      // typed is treated as a correction rather than a new meal.
      await ctx.reply(FIX_PROMPT(id, describeRow(row)), {
        reply_markup: { force_reply: true, input_field_placeholder: 'e.g. the chicken was 8oz' },
      });
      return;
    }

    if (action === 'again') {
      const row = queries.getEntry(config.authorizedChatId, id);
      if (!row) {
        await ctx.answerCallbackQuery({ text: `#${id} is gone` });
        return;
      }

      let items = [];
      try {
        const parsed = JSON.parse(row.items_json);
        items = Array.isArray(parsed) ? parsed : [];
      } catch {
        items = [];
      }

      // Copy the saved numbers verbatim at the current time. Source and
      // raw_input carry over — it is the same food, logged again — while ts is
      // now, so it lands on today.
      const result = {
        items,
        kcal: row.kcal,
        protein_g: row.protein_g,
        carbs_g: row.carbs_g,
        fat_g: row.fat_g,
        estimated: Boolean(row.estimated),
        // The original run's assumptions are not persisted, so state plainly
        // what this entry is rather than falling back to generic wording.
        assumptions: `copied from #${id}, numbers unchanged`,
        source: row.source,
      };
      const newId = queries.addEntry({
        chatId: config.authorizedChatId,
        ts: Date.now(),
        source: row.source,
        rawInput: row.raw_input,
        result,
      });

      await ctx.answerCallbackQuery({ text: `Logged again as #${newId}` });
      await ctx.reply(formatMealReply({ id: newId, result, totals: today().totals }), {
        reply_markup: entryKeyboard(newId),
      });
      return;
    }

    if (action === 'show') {
      const row = queries.getEntry(config.authorizedChatId, id);
      if (!row) {
        await ctx.answerCallbackQuery({ text: `#${id} is gone` });
        return;
      }
      await ctx.answerCallbackQuery();
      await ctx.reply(formatEntryReply(row, timeOf(row)), { reply_markup: entryKeyboard(id) });
      return;
    }

    await ctx.answerCallbackQuery();
  });

  // ---- Logging meals ------------------------------------------------------

  async function logAndReply(ctx, result, rawInput) {
    const id = queries.addEntry({
      chatId: config.authorizedChatId,
      ts: Date.now(),
      source: result.source,
      rawInput,
      result,
    });
    await ctx.reply(formatMealReply({ id, result, totals: today().totals }), {
      reply_markup: entryKeyboard(id),
    });
  }

  // Modes 1 and 2: one paid claude-haiku-4-5 call.
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith('/')) return;

    // A reply to a Fix prompt is a correction to that entry, NOT a new meal.
    // Without this check every attempted correction logs another meal.
    const repliedTo = ctx.message.reply_to_message;
    if (repliedTo?.from?.id === ctx.me.id) {
      const fixing = FIX_PROMPT_RE.exec(repliedTo.text ?? '');
      if (fixing) {
        await applyCorrection(ctx, Number(fixing[1]), text);
        return;
      }
    }

    await ctx.replyWithChatAction('typing').catch(() => {});
    try {
      const result = await analyzer.analyzeText(text);
      await logAndReply(ctx, result, text);
    } catch (error) {
      console.error('[bot] text analysis failed:', error);
      await ctx.reply(FRIENDLY_ERROR);
    }
  });

  /** Download, analyse and log a set of photos as ONE meal. */
  async function handlePhotos(ctx, photoSets, caption) {
    try {
      const buffers = [];
      for (const photo of photoSets) {
        // Smallest Telegram variant at or above 768px — least egress for the
        // resolution we actually need.
        const size = pickPhotoSize(photo);
        buffers.push(await downloadTelegramFile(ctx, size.file_id, config.telegramBotToken));
      }

      const result = await analyzer.analyzePhotos(buffers, caption);
      const fallbackLabel = buffers.length > 1 ? `(${buffers.length} photos)` : '(photo)';
      await logAndReply(ctx, result, caption ?? fallbackLabel);
    } catch (error) {
      console.error('[bot] photo analysis failed:', error);
      await ctx.reply(FRIENDLY_ERROR);
    }
  }

  // media_group_id -> photos collected so far, plus the timer that fires once
  // the group stops growing. In memory only: a restart mid-album loses it,
  // which is the right trade for not adding storage to a two-second window.
  const pendingAlbums = new Map();

  // Mode 3: downscale, then one paid claude-haiku-4-5 vision call.
  bot.on('message:photo', async (ctx) => {
    const caption = ctx.message.caption?.trim() || null;
    const groupId = ctx.message.media_group_id;

    // A lone photo needs no buffering.
    if (!groupId) {
      await ctx.replyWithChatAction('typing').catch(() => {});
      await handlePhotos(ctx, [ctx.message.photo], caption);
      return;
    }

    let album = pendingAlbums.get(groupId);
    if (!album) {
      album = { ctx, photoSets: [], caption: null, timer: null };
      pendingAlbums.set(groupId, album);
      // Shown once for the whole album, not once per photo.
      await ctx.replyWithChatAction('typing').catch(() => {});
    }

    album.photoSets.push(ctx.message.photo);
    // Telegram puts the caption on one message of the album; take the first.
    if (caption && !album.caption) album.caption = caption;

    // Each new photo pushes the deadline back, so the album fires only once
    // every part has landed.
    clearTimeout(album.timer);
    album.timer = setTimeout(() => {
      pendingAlbums.delete(groupId);
      handlePhotos(album.ctx, album.photoSets, album.caption).catch((error) => {
        console.error('[bot] album handling failed:', error);
      });
    }, ALBUM_SETTLE_MS);
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
