# dialedbot

A single-user calorie and macro tracking Telegram bot. One always-on Node.js
service on Railway, one SQLite file on a mounted volume. No second database, no
second host, no external services beyond Telegram and Anthropic.

Send it what you ate; it logs the meal and replies with the macros plus your
running total for the day. At 21:00 in your timezone it sends an unprompted
daily summary.

## API cost

All three input modes route through `claude-haiku-4-5`. Every logged meal costs
exactly one call; nothing else costs anything.

| Input | Route | Paid calls |
|---|---|---|
| Text — *"200g chicken breast and a cup of white rice"* | One `claude-haiku-4-5` call | **1** |
| Restaurant — *"chicken bowl from Chipotle with rice, black beans, guac"* | Same call. The prompt tells the model to use the chain's published values where it knows the item, and to estimate from the dish description otherwise | **1** |
| Photo | Downscaled to 768px JPEG, then one `claude-haiku-4-5` call | **1** |
| `/edit` | One call, re-estimating an existing entry | **1** |
| `/today`, `/undo`, the 21:00 summary | SQLite only | **0** |

The routing lives in [`src/analyze.js`](src/analyze.js), commented at each
decision point. No path makes more than one call.

Photos are the most expensive path per call, so two things keep them cheap:
Telegram already sends several pre-scaled variants, so the bot downloads the
smallest one that is still at least 768px rather than the full-size original;
then `sharp` resizes it to 768px on the longest side and re-encodes as JPEG.
That is roughly 590 image tokens instead of ~1600 for a full 1280px photo.

**Every figure is an estimate.** There is no lookup against a published nutrition
database, so each reply shows the assumptions the model made — portion sizes,
cooking fat, which options it assumed on a restaurant order — and `/edit` lets
you correct any of them.

## Commands

| Command | Effect |
|---|---|
| *(any text)* | Log a meal, reply with items, macros, assumptions, and today's total |
| *(any photo)* | Same, from the picture — add a caption for extra detail |
| `/today` | Today's running total; every entry is a tappable button |
| `/undo` | Delete the most recent entry |
| `/delete <id>` | Delete a specific entry |
| `/edit <id> <correction>` | Re-estimate an entry and update it in place |
| `/help` | Usage reminder |

Typing ids is the fallback, not the main path. Every logging reply carries
**✏️ Fix** and **🗑 Delete** buttons:

- **Delete** removes that entry immediately and rewrites the message to say so,
  so scrollback stays accurate. It reaches any entry, not just the most recent.
- **Fix** sends a reply prompt naming the entry. Whatever you type next is
  applied as a correction to it rather than logged as a new meal.

`/today` lists every entry of the day as a button; tapping one opens it with the
same two buttons. Button taps cost nothing — only the correction itself is a
paid call.

Every logging reply ends with the entry's id, so a bad estimate can be corrected
straight away:

```
• Chicken breast — 170g: 281 kcal · 53P / 0C / 6F
• White rice — 158g: 205 kcal · 4P / 45C / 0F

Meal: 486 kcal · 57P / 45C / 6F
Assumed: ~6oz cooked chicken breast, grilled dry; 1 cup cooked white rice
Today: 486 kcal · 57P / 45C / 6F · 1 meal

#42 · wrong portion? /edit 42 <correction>
```

```
/edit 42 the chicken was 8oz and cooked in a tablespoon of olive oil
```

Corrections keep the entry's original timestamp and source — a correction
changes the numbers, not when the meal happened — so one cannot move a meal
across a day boundary. Corrections accumulate as context, so a second fix on the
same entry still sees the original description.

**Why the reply prompt matters.** Typing a correction as an ordinary message
logs it as a *new meal* — the bot has no way to know it was meant as an edit.
Replying to a Fix prompt is unambiguous, which is why Fix is a button rather
than an instruction to type `/edit`.

## Railway setup

1. **Create the service.** In Railway: *New Project → Deploy from GitHub repo →*
   this repository. Nixpacks detects Node and runs `npm start`; no Dockerfile or
   build config is needed.

2. **Attach a volume — do this before the first real message.** With the service
   selected, open the *Variables/Settings* area and choose *+ Create → Volume*,
   attach it to this service, and set the mount path to **`/data`**. The SQLite
   file lives at `/data/foodlog.db`; without the volume it sits on the
   container's ephemeral disk and every redeploy wipes your log.

3. **Generate a public domain.** *Settings → Networking → Generate Domain*, and
   enter **8080** as the port. That is the port Railway forwards to inside the
   container, not part of the public URL. Railway then injects
   `RAILWAY_PUBLIC_DOMAIN`, which the bot reads on startup to register its
   Telegram webhook.

   Set `PORT=8080` in the variables too, so the port the app listens on and the
   port the router forwards to cannot drift apart. The startup log line
   `[server] listening on :8080` confirms they match.

4. **Set the environment variables** (*Variables* tab) — see the table below.

5. **Redeploy.** On boot the logs should show:

   ```
   [server] listening on :8080
   [db] /data is a mounted volume — data survives redeploys
   [db] using /data/foodlog.db
   [webhook] registered https://…/<secret-path>
   [summary] scheduled "0 21 * * *" in America/Chicago
   ```

   A volume that was created but never mounted is otherwise invisible — the
   directory is writable and everything works until a redeploy erases it — so
   startup checks whether `DB_PATH`'s directory is a real mount point and warns
   loudly if it is not.

   If you set the variables before generating the domain, you will instead see
   `[webhook] no PUBLIC_URL or RAILWAY_PUBLIC_DOMAIN set`. Generate the domain
   and redeploy.

### Environment variables

Copy [`.env.example`](.env.example) for the full annotated list.

| Variable | Required | Notes |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | From [@BotFather](https://t.me/BotFather) — send `/newbot` |
| `ANTHROPIC_API_KEY` | yes | [console.anthropic.com](https://console.anthropic.com) |
| `AUTHORIZED_CHAT_ID` | yes | Your chat ID — see below |
| `WEBHOOK_SECRET` | yes | Long random string; generate one with the command below |
| `TZ` | no — defaults `America/Chicago` | Any IANA name. **This is the one variable to change when you travel** — it moves both the daily-total boundaries and the 21:00 summary |
| `DB_PATH` | no — defaults `/data/foodlog.db` | Must be inside the mounted volume |
| `PORT` | no — defaults `8080` | Must match the port entered when generating the Railway domain |
| `PUBLIC_URL` | no | Only for a custom domain or a local tunnel; otherwise derived from `RAILWAY_PUBLIC_DOMAIN` |

Generate a webhook secret:

```bash
openssl rand -hex 32
```

Telegram only accepts `A-Z`, `a-z`, `0-9`, `_` and `-` in a webhook secret token,
so do not use a password generator with symbols enabled. The bot validates this
at startup and refuses to boot with a clear message rather than failing later on
an opaque Telegram 400.

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

You can also just paste that URL into a browser — no terminal needed:
`https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`.

Do this *before* the webhook is registered. Telegram will not serve `getUpdates`
while a webhook is active; if you have already deployed, run
`curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/deleteWebhook"` first, get the
ID, then redeploy to re-register.

Two alternatives that avoid the ordering problem entirely:

- Message [@userinfobot](https://t.me/userinfobot), which replies with your ID.
  Message it *directly* — nothing needs forwarding, and this has nothing to do
  with your own bot.
- Deploy with `AUTHORIZED_CHAT_ID` set to any placeholder, message your bot, and
  read the ID off the Railway log line: `[bot] ignored a message from chat
  123456789`. Set the real value and redeploy. Each unrecognised chat is logged
  once per process, so this also tells you if a stranger finds your bot.

## Running locally

```bash
cp .env.example .env      # fill it in; point DB_PATH at ./foodlog.db
npm install
node --env-file=.env src/index.js
```

Without `PUBLIC_URL` the service starts and serves HTTP but skips webhook
registration, so it will not receive messages. To exercise it end to end, expose
port 8080 with a tunnel (`cloudflared tunnel --url http://localhost:8080`) and
set `PUBLIC_URL` to the resulting HTTPS URL.

## Design notes

**Button taps need `callback_query`.** `allowed_updates` is deliberately narrow
to cut traffic, so it lists `message` and `callback_query` explicitly. Dropping
the latter would silently break every button.

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

**A failed `/edit` leaves the row alone.** The row is only rewritten after the
model returns a parseable result, so a timeout or a bad response cannot blank an
entry — the reply says the entry is unchanged.

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

`estimated` is always `1` now that every figure comes from the model. The column
is kept so the schema is unchanged and so the flag stays available if a lookup
source is ever added back.
