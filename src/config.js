import crypto from 'node:crypto';

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

// Telegram's setWebhook rejects a secret_token outside this charset, and it
// does so at startup with an opaque 400. Fail here with a usable message.
const TELEGRAM_SECRET_TOKEN = /^[A-Za-z0-9_-]{1,256}$/;

function assertValidWebhookSecret(secret) {
  if (!TELEGRAM_SECRET_TOKEN.test(secret)) {
    throw new Error(
      'WEBHOOK_SECRET may only contain A-Z, a-z, 0-9, _ and - (1-256 characters) — ' +
        'Telegram rejects any other character. Generate one with: openssl rand -hex 32',
    );
  }
  if (secret.length < 16) {
    console.warn(
      `[config] WEBHOOK_SECRET is only ${secret.length} characters. It guards a public URL — ` +
        'use at least 32. Generate one with: openssl rand -hex 32',
    );
  }
  return secret;
}

// Number('8080 ') is 8080, but Number('八080') is NaN — and server.listen(NaN)
// silently binds a random port, which looks healthy in the logs while the
// Railway router gets a 502. Fail loudly instead.
function assertValidPort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `PORT must be a whole number between 1 and 65535, got "${raw}". ` +
        'On Railway set it to 8080 and enter the same port when generating the domain.',
    );
  }
  return port;
}

function assertValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
  } catch {
    throw new Error(`TZ is not a valid IANA timezone: "${tz}" (e.g. America/Chicago, Europe/Lisbon)`);
  }
  return tz;
}

/**
 * Resolve the public HTTPS base URL for the Telegram webhook.
 * Railway injects RAILWAY_PUBLIC_DOMAIN once a domain is generated; PUBLIC_URL
 * lets you override it (custom domain, or a tunnel while testing locally).
 * Returns null when neither is set — the process still boots and serves HTTP,
 * it just skips webhook registration so you can start it before the domain exists.
 */
function resolvePublicUrl() {
  const explicit = optional('PUBLIC_URL', null);
  if (explicit) return explicit.replace(/\/+$/, '');
  const domain = optional('RAILWAY_PUBLIC_DOMAIN', null);
  if (domain) return `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  return null;
}

export function loadConfig() {
  const webhookSecret = assertValidWebhookSecret(required('WEBHOOK_SECRET'));

  return {
    telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
    anthropicApiKey: required('ANTHROPIC_API_KEY'),
    authorizedChatId: required('AUTHORIZED_CHAT_ID'),
    webhookSecret,

    // The URL path is derived from the secret rather than being the secret, so
    // the shared token never shows up in a URL, an access log, or a referrer.
    webhookPath: crypto.createHash('sha256').update(webhookSecret).digest('hex').slice(0, 32),

    // The Apple Health export lives on its own derived path and its own derived
    // bearer token. The token is NOT WEBHOOK_SECRET: it is stored on the phone
    // in a Shortcut, and if it ever leaks it must not also unlock the webhook.
    exportPath: crypto
      .createHash('sha256')
      .update(`${webhookSecret}:export-path`)
      .digest('hex')
      .slice(0, 32),
    exportToken: crypto
      .createHash('sha256')
      .update(`${webhookSecret}:export-token`)
      .digest('hex'),

    // Text descriptions are unambiguous, so the cheap model handles them well.
    // Photos are a much harder perception problem and were the source of
    // misidentifications, so they default to a stronger model. Both are
    // overridable without a code change.
    textModel: optional('TEXT_MODEL', 'claude-haiku-4-5'),
    photoModel: optional('PHOTO_MODEL', 'claude-sonnet-5'),
    photoMaxEdge: Number(optional('PHOTO_MAX_EDGE', '1568')),

    timeZone: assertValidTimeZone(optional('TZ', 'America/Chicago')),
    dbPath: optional('DB_PATH', '/data/foodlog.db'),
    port: assertValidPort(optional('PORT', '8080')),
    publicUrl: resolvePublicUrl(),
    summaryCron: '0 21 * * *', // 21:00 local time, every day
  };
}
