# Chitra AI — Backend

Node.js/Express API for the Chitra AI multi-tenant assistant platform. Deployed on **Render**.

## Features
- 🔐 Supabase JWT auth with tenant (`organization_id`) resolution
- 🧠 RAG pipeline: crawl/upload/manual text → chunk → embed (HuggingFace MiniLM or local fallback) → pgvector similarity search
- 🤖 Groq LLM chat with **tool calling**: `check_availability`, `create_booking`, `create_lead`
- 🔄 **Automatic OpenRouter fallback** — if Groq is down or rate-limited (429), requests fail over to OpenRouter instantly, with a 60s cooldown before retrying Groq
- ⏰ **Keep-alive self-ping** — pings `/health` every 14 min so the free Render instance never sleeps
- 📅 Internal booking calendar + owner notifications (webhook; SendGrid/Twilio-ready)
- 📊 Usage tracking & free-tier quotas (messages/month, documents, bookings)
- 🧩 `GET /widget.js?org=ORG_ID` — embeddable chat widget for any website
- 🔗 `GET /bot/:orgId` — hosted standalone chat page (QR-code / direct link)
- 🛡️ Helmet, CORS, rate limiting

## Local Setup
```bash
cd backend
npm install
cp .env.example .env   # fill in Supabase + Groq keys
npm run dev
```

## Database
Run `supabase/schema.sql` in the Supabase SQL Editor once. It creates all tables, RLS policies, the signup trigger, and the vector-match RPC.

## API Overview
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/chat` | public (rate-limited) | Chat with a business bot |
| GET | `/api/knowledge` | JWT | List documents |
| POST | `/api/knowledge/crawl` | JWT | Crawl a website |
| POST | `/api/knowledge/text` | JWT | Add manual text |
| POST | `/api/knowledge/upload` | JWT | Upload PDF/TXT/MD |
| DELETE | `/api/knowledge/:id` | JWT | Delete document |
| GET | `/api/bookings` | JWT | List bookings |
| PATCH | `/api/bookings/:id` | JWT | Update booking status |
| GET | `/api/leads` | JWT | List leads |
| GET | `/api/analytics` | JWT | Dashboard stats |
| GET | `/api/org/me` | JWT | Org + settings + usage |
| PATCH | `/api/org/settings` | JWT | Update bot settings |
| POST | `/api/org/api-key` | JWT | Generate widget API key |
| GET | `/api/org/openwa/status` | JWT | Self-hosted OpenWA connection status |
| POST | `/api/org/openwa/connect` | JWT | Verify + connect an OpenWA session |
| POST | `/api/org/openwa/disconnect` | JWT | Soft-off the org's session: stops replies until Reconnect (mapping + audit row kept) |
| POST | `/api/org/openwa/reconnect` | JWT | Reconcile + restart the session: repair the webhook first (fixes group filters), then start when down, then resume answering |
| POST | `/api/org/openwa/settings` | JWT | Per-org WhatsApp behaviour: `{ groupRepliesEnabled }` (V12), `{ autoReply }` (V13) |
| POST | `/api/org/openwa/webhook/repair` | JWT | Inspect the session's webhooks; delete group-excluding filters and re-register clean (no-op when already correct) |
| POST | `/api/org/openwa/test` | JWT | Send a test WhatsApp message via OpenWA |
| POST | `/api/webhooks/openwa` | HMAC (signed) | Inbound OpenWA webhook (message.received) |
| GET | `/wa-pending` (and `/api/wa-pending`) | public | Pending WhatsApp counts for Muse's event hook (no message content) |
| GET | `/widget.js?org=` | public | Widget loader script |
| GET | `/bot/:orgId` | public | Hosted chat page |
| GET | `/health` | public | Health check |

## Deploy to Render
1. New → **Web Service** → connect this repo, root directory `backend`
2. Build: `npm install` · Start: `npm start`
3. Add env vars from `.env.example` (set `CORS_ORIGINS` to your Vercel URL, `PUBLIC_BACKEND_URL` to the Render URL)
4. Health check path: `/health`

## OpenWA (self-hosted WhatsApp) integration

Chitra can answer WhatsApp messages through a **self-hosted [OpenWA](https://github.com/rmyndharis/OpenWA) gateway** instead of the Meta WhatsApp Cloud API. OpenWA runs as an external service (e.g. on your own machine via Docker) and is reached from Render through a **Cloudflare Tunnel**. Inbound WhatsApp messages reuse Chitra's **existing** RAG/Groq/tools pipeline — no duplicate AI logic.

### Message flow
```
Customer WhatsApp → OpenWA session (your machine)
  → webhook POST /api/webhooks/openwa (HMAC-signed)
  → resolve org from whatsapp_connections by openwa_session_id
  → store user turn (chat_history, channel='whatsapp')
  → existing runChatForChannel(): RAG + Groq(OpenRouter fallback) + tools + quota
  → store assistant turn
  → openwa.sendText() via Cloudflare Tunnel → user's WhatsApp
```

### Environment variables
| Variable | Local | Production |
|---|---|---|
| `OPENWA_BASE_URL` | `http://localhost:2785` | `https://wa.<your-domain>` (tunnel) |
| `OPENWA_API_KEY` | OpenWA `X-API-Key` | same |
| `OPENWA_WEBHOOK_SECRET` | ≥16-char string | same (both sides) |
| `WHATSAPP_AUTO_REPLY` | `off` (default) | `off` = the Channels toggle decides; `on` = force this backend to answer |

All three are **server-only** — never exposed to the browser.

### Database migration
Run [`supabase/migration_v6_openwa.sql`](./supabase/migration_v6_openwa.sql) once in the Supabase SQL Editor. It creates `whatsapp_connections` (maps one OpenWA session → one org) with RLS, so no org can read another's connection.

### Configure the webhook
The backend auto-registers the webhook on `POST /api/org/openwa/connect` pointing to
`https://<your-api>/api/webhooks/openwa` with events `["message.received"]` and the
`OPENWA_WEBHOOK_SECRET`. Verify at `GET /api/org/openwa/status`.

### Security
- Webhook HMAC-SHA256 (`X-OpenWA-Signature`) verified over the raw body.
- The org for an inbound message is resolved **from the DB** (`whatsapp_connections`), never from the webhook payload.
- `OPENWA_API_KEY`, `OPENWA_WEBHOOK_SECRET`, and Supabase keys are never logged or committed (`.env` is gitignored).

---

## Muse mode — event-driven WhatsApp (`WHATSAPP_AUTO_REPLY` + the Channels toggle)

Instead of this backend answering WhatsApp itself, **Muse** (the external agent) can own the
replies. Two layers, so the owner gets a switch and ops keeps a rollback:

1. **The Channels page toggle** — *Answer WhatsApp from Chitra* (on the WhatsApp (OpenWA)
   card). Stored per org as `whatsapp_connections.auto_reply_enabled`
   (**run [`supabase/migration_v13_openwa_auto_reply.sql`](./supabase/migration_v13_openwa_auto_reply.sql)
   once**; until then the backend stays in Muse mode and the toggle says which file to run).
2. **`WHATSAPP_AUTO_REPLY=on`** — the ops override. It forces this backend to answer for every
   org whatever the dashboard says, so an emergency rollback is still one flag flip. The
   toggle is disabled and labelled *forced by server config* in that case.

| Mode | Who replies | What the backend does |
|---|---|---|
| Muse *(default: toggle off)* | Muse | Never replies. Stores one pending row per inbound message *before* acking, serves `GET /wa-pending`, settles a chat when Muse's own outgoing message is seen. |
| Chitra *(toggle on)* | this backend | The original automatic reply path, exactly as it was (existing RAG/Groq/tools pipeline). Nothing new is counted for Muse. |

Older pending rows stay on the feed when you flip to Chitra (they predate someone who
would answer them) and settle themselves the next time the bot replies in that chat —
they are never silently dropped. `suspended` in the log only means the bot is switched
off (`whatsapp_connections.status`), never that the message was ignored: a switched-off
session still records everything for Muse.

### Disconnect / Reconnect (soft switch)
**Disconnect** on the card does *not* log the WhatsApp session out: it writes
`whatsapp_connections.status = 'disconnected'` and keeps the mapping, so the card shows
**Disconnected**, offers **Reconnect**, and *stops the backend answering* — neither Chitra mode
nor a saved-auto-reply toggle can send while it is off (the toggle then reads *saved on, but
suspended*). **Reconnect** reconciles with the gateway — it checks the live session first and
only calls OpenWA's `POST /sessions/{id}/start` when the session is actually down (so an
already-started session reports success instead of 502 "already started" and leaving the row
stuck at 'disconnected'); then it writes `status = 'connected'` and answering resumes. A
genuinely broken session still 502s with the gateway's own message, and the row stays
'disconnected'. Both invalidate the cached mode immediately, so the next message follows
the switch, not a 30-second timer.

### Flow
```
Customer WhatsApp → OpenWA session → webhook POST /api/webhooks/openwa (HMAC)
  → (Muse mode) mention gate: direct message, or a group message that
    @-mentions this bot's number / @lid / display name
  → record as pending: chatId + author + waMessageId + body, BEFORE the 200
Muse's hook: GET /wa-pending  → { new_messages, pending_chats, pending, session_ready, mode }
  → when new_messages > 0: read the messages through the OpenWA API, reply per the
    reply playbook (groups: answer in the group and tag `author`), mark the chat read
  → OpenWA echoes Muse's own send back to the webhook (fromMe: true)
  → backend clears that chat's pending rows (no ack API needed)
  → when session_ready is false: Muse emails Meena about the outage
```

Group messages pass a **mention gate** before anything is written: only a line that
@-mentions this bot is work for Muse. The mention may arrive as the stored number
(`@9779712039906`), the session's privacy id (`@248065197879524@lid` — learned from
the group roster or resolved through the contacts lookup, both cached) or the display
name. Unaddressed chatter in a busy team group is never counted, and the backend
never replies in Muse mode — Muse does, so there are no double replies.

If the gateway's webhook carries a group-excluding filter (`{ "isGroup": false }`),
group messages die at the gateway before our code runs. **Reconnect now repairs the
wiring itself** (it inspects the session's hooks before starting anything), and you
can always repair explicitly: `POST /api/org/openwa/webhook/repair` — or the
**Fix webhook** button on the Channels card, which appears next to a warning when
`GET /api/org/openwa/status` reports `"webhookFiltered": true`. The repair deletes a
filtered hook where the gateway build allows and re-registers a clean one — no filters,
`message.received` + the HMAC secret — and is a strict no-op on an already-correct hook.

### The endpoint
`GET /wa-pending` (also mounted as `/api/wa-pending`) — public, no auth, no DB call:

```json
{ "new_messages": 2, "pending_chats": ["97798XXXXXXXX@c.us"], "session_ready": true, "mode": "muse" }
```

Group mentions add per-message reply hints (`pending`, newest first, capped):

```json
{
  "new_messages": 1,
  "pending_chats": ["120363428240535325@g.us"],
  "pending": [
    {
      "chat_id": "120363428240535325@g.us",
      "session_id": "03bc39c2-…",
      "is_group": true,
      "message_id": "false_202229004943510@lid_…",
      "author": "202229004943510@lid",
      "author_name": "Sanjeev",
      "body": "Recommend some good business names for the online e-commerce @248065197879524",
      "mentioned_ids": ["248065197879524@lid"],
      "matched_by": "mentionedIds",
      "received_at": "2026-09-30T20:05:00.000Z"
    }
  ],
  "session_ready": true,
  "mode": "muse"
}
```

- `new_messages` — pending inbound messages not yet handled by Muse.
- `pending_chats` — chats holding pending messages, most recently active first.
- `pending` — the reply hints (groups only): answer in `chat_id`, tag `author`,
  quote/use `message_id`; `matched_by` records how the bot's own mention was
  recognised. Capped by `WA_PENDING_DETAIL_LIMIT`, bodies by `WA_PENDING_BODY_CHARS`.
- `session_ready` — `false` only on real evidence (an authoritative "down" status, or
  `WA_SESSION_DOWN_AFTER` consecutive failed probes of `GET /sessions/{id}`). Unknown
  reads as `true` so a fresh process never causes a false outage alert.
- `mode` — `"muse"` when this feed is authoritative; `"bot"` when the backend was switched
  back to `on`, so Muse can stand down instead of racing it.

Because `pending` names who said what, set `WA_PENDING_TOKEN` if this feed is reachable
from the open internet: with it set, the details require `?token=…` or an `x-wa-token`
header, while counts / chat ids / mode stay public.

Pending state is a table, not process memory (`wa_pending_messages`,
**run [`supabase/migration_v14_wa_pending.sql`](./supabase/migration_v14_wa_pending.sql) once**).
Every inbound message becomes one row *before* the webhook is acknowledged, so an
acknowledged delivery can never be lost by a restart — the incident
("Message counted for Muse …, suspended: true" in the log, feed stuck at 0 afterwards)
was exactly that: the count lived only in memory and died with the process, and the
ack had already told OpenWA not to retry. `event_key` is unique, so OpenWA retries
are idempotent across restarts too. Rows carry chat id, gateway message id and
timestamps — no message text is ever stored, which is why the endpoint can stay
unauthenticated.

The old in-memory mirror only runs when the table is missing (you get a one-line
"run migration_v14" warning) or the DB blinks mid-read: the feed would rather show
a stale guess than 0, because 0 puts Muse back to sleep. Rows age out by themselves:
pending rows expire after `WA_PENDING_EXPIRE_DAYS` (they stop waking Muse), and
settled rows are deleted after `WA_HANDLED_KEEP_DAYS`. Entries are cleared only by
an observed reply or by that expiry — never by a restart, a toggle, or a mode
change. The hook's frequent polls also keep a sleeping Render instance awake.

### Rollback
Set `WHATSAPP_AUTO_REPLY=on` and the backend goes straight back to self-replying. One flag,
no deploy of old code.

### Test
`npm run test:unit` (from `backend/`) drives the whole contract offline — no credentials, no
gateway, no DB: signed webhook in, pending counted, outbound echo clears it, readiness flips
on lifecycle events, the dashboard toggle routes messages back to the reply pipeline, and a
deploy without migration_v13 stays safely in Muse mode.
