# dialedbot

A single-user calorie and macro tracking Telegram bot. One always-on Node.js
service on Railway, one SQLite file on a mounted volume. No second database, no
second host, no external services beyond Telegram, Nutritionix, and Anthropic.

Send it what you ate; it logs the meal and replies with the macros plus your
running total for the day. At 21:00 in your timezone it sends an unprompted
daily summary.

## How it minimizes paid API calls

| Input | Route | Paid calls |
|---|---|---|
| Text — *"200g chicken breast and a cup of white rice"* | Nutritionix natural-language endpoint (free) | **0** |
| Restaurant — *"chicken bowl from Chipotle with rice, black beans, guac"* | Same endpoint — its branded database covers chains and returns published numbers | **0** |
| Either of the above, no match | Falls back to one `claude-haiku-4-5` call, flagged as an estimate | **1** |
| Photo | Downscaled to 768px JPEG, then one `claude-haiku-4-5` call | **1** |
| `/today`, `/undo`, the 21:00 summary | SQLite only | **0** |

Nutritionix is always tried first for text, and the model is only reached on a
miss. The routing lives in [`src/analyze.js`](src/analyze.js), commented at each
decision point.

Photos are the one unavoidable paid path. Two things keep them cheap: Telegram
already sends several pre-scaled variants, so the bot downloads the smallest one
that is still at least 768px rather than the full-size original; then `sharp`
resizes it to 768px on the longest side and re-encodes as JPEG. That is roughly
590 image tokens instead of ~1600 for a full 1280px photo.

## Commands

| Command | Effect |
|---|---|
| *(any text)* | Log a meal, reply with items, macros, and today's total |
| *(any photo)* | Same, from the picture — add a caption for extra detail |
| `/today` | Today's running total on demand |
| `/undo` | Delete the most recent entry |
| `/help` | Usage reminder |

## Railway setup

1. **Create the service.** In Railway: *New Project → Deploy from GitHub repo →*
   this repository. Nixpacks detects Node and runs `npm start`; no Dockerfile or
   build config is needed.

2. **Attach a volume — do this before the first real message.** With the service
   selected, open the *Variables/Settings* area and choose *+ Create → Volume*,
   attach it to this service, and set the mount path to **`/data`**. The SQLite
   file lives at `/data/foodlog.db`; without the volume it sits on the
   container's ephemeral disk and every redeploy wipes your log.

3. **Generate a public domain.** *Settings → Networking → Generate Domain*.
   Railway then injects `RAILWAY_PUBLIC_DOMAIN`, which the bot reads on startup
   to register its Telegram webhook. It also injects `PORT` — do not set that
   yourself.

4. **Set the environment variables** (*Variables* tab) — see the table below.

5. **Redeploy.** On boot the logs should show `[server] listening on :…`,
   `[webhook] registered https://…/<secret-path>`, and
   `[summary] scheduled "0 21 * * *" in America/Chicago`.

   If you set the variables before generating the domain, you will instead see
   `[webhook] no PUBLIC_URL or RAILWAY_PUBLIC_DOMAIN set`. Generate the domain
   and redeploy.

### Environment variables

Copy [`.env.example`](.env.example) for the full annotated list.

| Variable | Required | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | From [@BotFather](https://t.me/BotFather) — send `/newbot` |
| `ANTHROPIC_API_KEY` | yes | [console.anthropic.com](https://console.anthropic.com) |
| `NUTRITIONIX_APP_ID` | yes | Free key at [developer.nutritionix.com](https://developer.nutritionix.com/) |
| `NUTRITIONIX_API_KEY` | yes | Same signup |
| `AUTHORIZED_CHAT_ID` | yes | Your chat ID — see below |
| `WEBHOOK_SECRET` | yes | Long random string; generate one with the command below |
| `TZ` | no — defaults `America/Chicago` | Any IANA name. **This is the one variable to change when you travel** — it moves both the daily-total boundaries and the 21:00 summary |
| `DB_PATH` | no — defaults `/data/foodlog.db` | Must be inside the mounted volume |
| `PORT` | no | Railway injects it |
| `PUBLIC_URL` | no | Only for a custom domain or a local tunnel; otherwise derived from `RAILWAY_PUBLIC_DOMAIN` |

Generate a webhook secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Finding your `AUTHORIZED_CHAT_ID`

The bot token is publicly reachable by anyone who learns it, so every message
from a chat other than this one is dropped without a reply.

1. Open Telegram and send your new bot any message (say `hello`).
2. Run this with your token substituted in:

   ```bash
   curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates" \
     | grep -o '"chat":{"id":[-0-9]*'
   ```

   The number after `"id":` is your chat ID — a positive integer for a personal
   chat.

Do this *before* the webhook is registered. Telegram will not serve `getUpdates`
while a webhook is active; if you have already deployed, run
`curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/deleteWebhook"` first, get the
ID, then redeploy to re-register.

Alternatively, message [@userinfobot](https://t.me/userinfobot), which replies
with your ID directly.

## Running locally

```bash
cp .env.example .env      # fill it in; point DB_PATH at ./foodlog.db
npm install
node --env-file=.env src/index.js
```

Without `PUBLIC_URL` the service starts and serves HTTP but skips webhook
registration, so it will not receive messages. To exercise it end to end, expose
port 3000 with a tunnel (`cloudflared tunnel --url http://localhost:3000`) and
set `PUBLIC_URL` to the resulting HTTPS URL.

## Design notes

**Webhook, not long polling.** The process sits idle between messages instead of
holding an open request to Telegram, which is what keeps Railway CPU and egress
near zero. `allowed_updates: ['message']` means Telegram never sends update types
the bot does not handle.

**The webhook path is derived, not shared.** The URL path is
`sha256(WEBHOOK_SECRET)` truncated to 32 hex characters, so the secret itself
never appears in a URL or an access log. `WEBHOOK_SECRET` is separately sent to
Telegram as its secret token and compared in constant time on every incoming
request.

**The webhook answers before it works.** The server validates the request,
returns `200`, and analyses the meal afterwards. A slow photo call can never trip
Telegram's timeout and cause a retry that double-logs the same meal.

**One process, both jobs.** `node-cron` runs the 21:00 summary inside the same
service that handles messages — no separate Railway cron service. The job
computes the local day's UTC bounds from `TZ`, sums the rows, and sends one
message.

**Timezone handling is offset-aware.** `src/time.js` resolves local midnight to
UTC by applying the zone offset twice, which converges correctly across DST
transitions and half-hour zones (verified against a 23-hour DST day in Chicago
and `Asia/Kathmandu` at +05:45).

**Model output is treated as untrusted.** Requests ask for a strict JSON shape
via `output_config`, but responses are still parsed defensively: code fences
stripped, the outermost `{…}` extracted, `JSON.parse` in a `try`/`catch`, every
number coerced, and the meal totals recomputed by summing the items rather than
trusting a separately-generated total. If the endpoint ever rejects
`output_config`, the bot retries once without it and remembers not to send it
again for the life of the process (a rejected request is not billed).

**Failures reply, they do not crash.** Every handler is wrapped, `bot.catch`
backstops grammY, and process-level handlers log without exiting. A message that
cannot be analysed gets a friendly error and writes no row.

## Layout

```
src/
  index.js        startup: config, DB, server, webhook registration, cron
  config.js       environment parsing and validation
  server.js       minimal HTTP server: health check + verified webhook endpoint
  bot.js          grammY handlers, chat-ID gate, commands
  analyze.js      routing — where the one paid call happens in each path
  nutritionix.js  free natural-language nutrients lookup
  llm.js          claude-haiku-4-5 client, strict JSON shape, defensive parsing
  image.js        Telegram size selection + 768px JPEG downscale
  db.js           SQLite schema and queries
  summary.js      21:00 node-cron job
  time.js         IANA timezone local-day arithmetic
  format.js       Telegram reply text
```

## Schema

```sql
CREATE TABLE food_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    TEXT NOT NULL,
  ts         INTEGER NOT NULL,      -- unix ms, UTC
  source     TEXT NOT NULL,         -- 'text' | 'restaurant' | 'photo'
  raw_input  TEXT,
  items_json TEXT NOT NULL,
  kcal       REAL NOT NULL,
  protein_g  REAL NOT NULL,
  carbs_g    REAL NOT NULL,
  fat_g      REAL NOT NULL,
  estimated  INTEGER NOT NULL DEFAULT 0
);
```
