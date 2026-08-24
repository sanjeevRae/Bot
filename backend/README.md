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
| GET | `/widget.js?org=` | public | Widget loader script |
| GET | `/bot/:orgId` | public | Hosted chat page |
| GET | `/health` | public | Health check |

## Deploy to Render
1. New → **Web Service** → connect this repo, root directory `backend`
2. Build: `npm install` · Start: `npm start`
3. Add env vars from `.env.example` (set `CORS_ORIGINS` to your Vercel URL, `PUBLIC_BACKEND_URL` to the Render URL)
4. Health check path: `/health`
