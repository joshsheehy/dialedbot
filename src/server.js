import http from 'node:http';
import crypto from 'node:crypto';

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
export function createServer({ config, bot }) {
  const webhookRoute = `/${config.webhookPath}`;

  return http.createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && (url === '/' || url === '/health')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
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
