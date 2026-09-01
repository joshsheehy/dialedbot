import { loadConfig } from './config.js';
import { openDb, createQueries } from './db.js';
import { createLlm } from './llm.js';
import { createAnalyzer } from './analyze.js';
import { createBot } from './bot.js';
import { createServer } from './server.js';
import { startDailySummary } from './summary.js';

async function main() {
  const config = loadConfig();

  const db = openDb(config.dbPath);
  const queries = createQueries(db);
  const llm = createLlm(config.anthropicApiKey);
  const analyzer = createAnalyzer({ llm });
  const bot = createBot({ config, queries, analyzer });

  // Webhook mode: no long polling, so the process sits idle between messages.
  await bot.init();

  const server = createServer({ config, queries, bot });
  await new Promise((resolve) => server.listen(config.port, resolve));
  console.log(`[server] listening on :${config.port}`);
  console.log(`[db] using ${config.dbPath}`);

  if (config.publicUrl) {
    const webhookUrl = `${config.publicUrl}/${config.webhookPath}`;
    await bot.api.setWebhook(webhookUrl, {
      secret_token: config.webhookSecret,
      // Only ask Telegram for what we actually handle — fewer requests hitting
      // the service, less egress. callback_query carries the inline-button
      // taps; without it Telegram never delivers them.
      allowed_updates: ['message', 'callback_query'],
      // Don't replay a backlog of messages accumulated during a redeploy.
      drop_pending_updates: true,
    });
    console.log(`[webhook] registered ${config.publicUrl}/<secret-path>`);
  } else {
    console.warn(
      '[webhook] no PUBLIC_URL or RAILWAY_PUBLIC_DOMAIN set — skipping registration. ' +
        'Generate a Railway domain, then redeploy.',
    );
  }

  const summary = startDailySummary({ bot, queries, config });

  const shutdown = (signal) => {
    console.log(`[shutdown] ${signal} received`);
    summary.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Don't hang forever on a lingering keep-alive connection.
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A single bad message must never take the service down.
  process.on('unhandledRejection', (reason) => {
    console.error('[process] unhandled rejection:', reason);
  });
  process.on('uncaughtException', (error) => {
    console.error('[process] uncaught exception:', error);
  });
}

main().catch((error) => {
  console.error('[startup] fatal:', error);
  process.exit(1);
});
