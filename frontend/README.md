# Chitra AI — Frontend

Next.js 14 + Tailwind dashboard for the Chitra AI platform. Deployed on **Vercel**.

## Pages
| Route | Description |
|---|---|
| `/` | Marketing landing page |
| `/signup` | Create account (+ auto-creates org via DB trigger) |
| `/login` | Log in |
| `/onboarding` | Teach the bot: crawl website or paste text |
| `/dashboard` | Stats, test chat, install snippet & direct link |
| `/knowledge` | Manage knowledge: crawl / upload / manual text |
| `/bookings` | View & manage bot-made bookings |
| `/leads` | Captured leads |
| `/settings` | Bot name, welcome message, color, notifications, API keys |

## Local Setup
```bash
cd frontend
npm install
cp .env.example .env.local   # fill in Supabase + backend URL
npm run dev                  # http://localhost:3000
```

## Linking to the Backend
The frontend talks to the Express backend on Render through `NEXT_PUBLIC_API_URL`.
All authenticated requests attach the Supabase JWT automatically (`lib/supabaseClient.js`).

## Deploy to Vercel
1. Import this repo into Vercel, **root directory: `frontend`**
2. Add env vars from `.env.example`
3. Set `NEXT_PUBLIC_API_URL` to your Render backend URL
4. In Render, set `CORS_ORIGINS` to include your Vercel URL
