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
| POST | `/api/org/openwa/disconnect` | JWT | Disconnect the org's OpenWA session |
| POST | `/api/org/openwa/reconnect` | JWT | Ask OpenWA to (re)start the org's session |
| POST | `/api/org/openwa/test` | JWT | Send a test WhatsApp message via OpenWA |
| POST | `/api/webhooks/openwa` | HMAC (signed) | Inbound OpenWA webhook (message.received) |
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
