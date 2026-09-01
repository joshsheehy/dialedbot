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
  const webhookSecret = required('WEBHOOK_SECRET');

  return {
    telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
    anthropicApiKey: required('ANTHROPIC_API_KEY'),
    authorizedChatId: required('AUTHORIZED_CHAT_ID'),
    webhookSecret,

    // The URL path is derived from the secret rather than being the secret, so
    // the shared token never shows up in a URL, an access log, or a referrer.
    webhookPath: crypto.createHash('sha256').update(webhookSecret).digest('hex').slice(0, 32),

    timeZone: assertValidTimeZone(optional('TZ', 'America/Chicago')),
    dbPath: optional('DB_PATH', '/data/foodlog.db'),
    port: Number(optional('PORT', '3000')),
    publicUrl: resolvePublicUrl(),
    summaryCron: '0 21 * * *', // 21:00 local time, every day
  };
}
