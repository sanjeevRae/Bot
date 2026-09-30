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
| POST | `/api/org/openwa/reconnect` | JWT | Restart the OpenWA session and resume answering |
| POST | `/api/org/openwa/settings` | JWT | Per-org WhatsApp behaviour: `{ groupRepliesEnabled }` (V12), `{ autoReply }` (V13) |
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
| Muse *(default: toggle off)* | Muse | Never replies. Counts incoming messages per chat, serves `GET /wa-pending`, clears a chat when Muse's own outgoing message is seen. |
| Chitra *(toggle on)* | this backend | The original automatic reply path, exactly as it was (existing RAG/Groq/tools pipeline). Nothing is counted for Muse. |

Switching to Chitra clears the pending list, because Muse is no longer answering that session.

### Disconnect / Reconnect (soft switch)
**Disconnect** on the card does *not* log the WhatsApp session out: it writes
`whatsapp_connections.status = 'disconnected'` and keeps the mapping, so the card shows
**Disconnected**, offers **Reconnect**, and *stops the backend answering* — neither Chitra mode
nor a saved-auto-reply toggle can send while it is off (the toggle then reads *saved on, but
suspended*). **Reconnect** calls OpenWA's `POST /sessions/{id}/start`, writes `status = 'connected'`
and answering resumes. Both invalidate the cached mode immediately, so the next message follows
the switch, not a 30-second timer.

### Flow
```
Customer WhatsApp → OpenWA session → webhook POST /api/webhooks/openwa (HMAC)
  → (auto-reply off) count as pending: chatId + count + timestamp, in memory
Muse's hook: GET /wa-pending  → { new_messages, pending_chats, session_ready, mode }
  → when new_messages > 0: read the messages through the OpenWA API, reply per the
    reply playbook, mark the chat read
  → OpenWA echoes Muse's own send back to the webhook (fromMe: true)
  → backend clears that chat's pending entry (no ack API needed)
  → when session_ready is false: Muse emails Meena about the outage
```

### The endpoint
`GET /wa-pending` (also mounted as `/api/wa-pending`) — public, no auth, no DB call:

```json
{ "new_messages": 2, "pending_chats": ["97798XXXXXXXX@c.us"], "session_ready": true, "mode": "muse" }
```

- `new_messages` — pending inbound messages not yet handled by Muse.
- `pending_chats` — chats holding pending messages, most recently active first.
- `session_ready` — `false` only on real evidence (an authoritative "down" status, or
  `WA_SESSION_DOWN_AFTER` consecutive failed probes of `GET /sessions/{id}`). Unknown
  reads as `true` so a fresh process never causes a false outage alert.
- `mode` — `"muse"` when this feed is authoritative; `"bot"` when the backend was switched
  back to `on`, so Muse can stand down instead of racing it.

Pending state is deliberately in memory, bounded (`WA_PENDING_MAX_CHATS`, oldest chats
dropped first) and content-free — no message text is ever stored, which is why the endpoint
can stay unauthenticated. A restart loses counts: they are only a wake-up signal, and OpenWA
remains the source of truth for what was actually said. The hook's frequent polls also keep a
sleeping Render instance awake.

### Rollback
Set `WHATSAPP_AUTO_REPLY=on` and the backend goes straight back to self-replying. One flag,
no deploy of old code.

### Test
`npm run test:unit` (from `backend/`) drives the whole contract offline — no credentials, no
gateway, no DB: signed webhook in, pending counted, outbound echo clears it, readiness flips
on lifecycle events, the dashboard toggle routes messages back to the reply pipeline, and a
deploy without migration_v13 stays safely in Muse mode.
