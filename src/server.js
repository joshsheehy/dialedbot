import http from 'node:http';
import crypto from 'node:crypto';
import { localDayRangeForYmd, resolveDaySelector } from './time.js';

const MAX_BODY_BYTES = 1_000_000;

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Minimal HTTP server: a health check plus the Telegram webhook endpoint.
 *
 * The webhook responds 200 as soon as the update is validated and processes it
 * afterwards. That keeps the response well inside Telegram's timeout even when
 * a photo takes several seconds to analyse, and stops Telegram from retrying
 * (and re-logging) a slow-but-successful meal.
 */
/**
 * Apple Health export. HealthKit has no server API — only code running on the
 * device can write to it — so the bot's job is to publish the day's numbers in
 * a shape an iOS Shortcut can read and log with "Log Health Sample".
 *
 * Read-only, DB only, no API call.
 */
function handleExport({ config, queries, url, req, res }) {
  const provided = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!timingSafeEqual(provided, config.exportToken)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const selector = new URL(url, 'http://localhost').searchParams.get('date') ?? 'today';
  const ymd = resolveDaySelector(config.timeZone, selector);
  if (!ymd) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'date must be today, yesterday, or YYYY-MM-DD' }));
    return;
  }

  const { start, end } = localDayRangeForYmd(config.timeZone, ymd.year, ymd.month, ymd.day);
  const totals = queries.totalsForRange(config.authorizedChatId, start, end);
  const rows = queries.entriesForRange(config.authorizedChatId, start, end);

  const pad = (n) => String(n).padStart(2, '0');
  const body = {
    date: `${ymd.year}-${pad(ymd.month)}-${pad(ymd.day)}`,
    timezone: config.timeZone,
    meals: totals.meals,
    // Daily totals — the simplest thing for a Shortcut to log as four samples.
    kcal: Math.round(totals.kcal),
    protein_g: Math.round(totals.protein_g),
    carbs_g: Math.round(totals.carbs_g),
    fat_g: Math.round(totals.fat_g),
    // Per-meal rows, for a Shortcut that wants real timestamps instead of one
    // daily lump.
    entries: rows.map((row) => {
      let items = [];
      try {
        const parsed = JSON.parse(row.items_json);
        items = Array.isArray(parsed) ? parsed : [];
      } catch {
        items = [];
      }
      return {
        id: row.id,
        at: new Date(row.ts).toISOString(),
        name: items.map((item) => item.name).join(', ') || 'meal',
        source: row.source,
        kcal: Math.round(row.kcal),
        protein_g: Math.round(row.protein_g),
        carbs_g: Math.round(row.carbs_g),
        fat_g: Math.round(row.fat_g),
      };
    }),
  };

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createServer({ config, queries, bot }) {
  const webhookRoute = `/${config.webhookPath}`;
  const exportRoute = `/${config.exportPath}`;

  return http.createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && (url === '/' || url === '/health')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method === 'GET' && url === exportRoute) {
      handleExport({ config, queries, url: req.url ?? '/', req, res });
      return;
    }

    if (req.method !== 'POST' || url !== webhookRoute) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    if (!timingSafeEqual(req.headers['x-telegram-bot-api-secret-token'], config.webhookSecret)) {
      console.warn('[server] rejected webhook request with a bad secret token');
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end('unauthorized');
      return;
    }

    let update;
    try {
      update = JSON.parse(await readBody(req));
    } catch (error) {
      console.warn('[server] bad webhook body:', error.message);
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }

    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');

    bot.handleUpdate(update).catch((error) => {
      console.error('[server] update handling failed:', error);
    });
  });
}
