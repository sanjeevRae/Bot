require('dotenv').config();

const config = {
  port: process.env.PORT || 5000,
  env: process.env.NODE_ENV || 'development',

  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY, // server-only
    anonKey: process.env.SUPABASE_ANON_KEY,
  },

  groq: {
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
  },

  // Secondary Groq account — used when the primary fails or rate-limits
  groq2: {
    apiKey: process.env.GROQ_API_KEY_2 || '',
    model: process.env.GROQ_MODEL_2 || 'llama-3.1-8b-instant',
  },

  // Fallback LLM provider (used when Groq is down or rate-limited)
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct:free',
  },

  // V2 messaging channels (Meta Cloud APIs)
  meta: {
    apiVersion: process.env.META_GRAPH_VERSION || 'v20.0',
    verifyToken: process.env.META_VERIFY_TOKEN || 'chitra-verify',
  },
  whatsapp: {
    // WhatsApp Cloud API — one business phone number per deployment
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  },
  messenger: {
    pageToken: process.env.MESSENGER_PAGE_TOKEN || '',
  },

  // Self-hosted OpenWA WhatsApp gateway (external service — runs on the user's own
  // machine/Docker, reached from Render via a Cloudflare Tunnel). API auth uses the
  // X-API-Key header; webhooks are HMAC-signed with webhookSecret.
  //  - baseUrl: http://localhost:2785 in local dev, https://wa.<your-domain> in production.
  openwa: {
    baseUrl: process.env.OPENWA_BASE_URL || '',
    apiKey: process.env.OPENWA_API_KEY || '',            // server-only; never exposed to the frontend
    webhookSecret: process.env.OPENWA_WEBHOOK_SECRET || '', // >= 16 chars; signs OpenWA webhook deliveries
  },

  // Email notifications (Resend — free tier: 100 emails/day, no card)
  email: {
    apiKey: process.env.RESEND_API_KEY || '',
    from: process.env.EMAIL_FROM || 'Chitra AI <onboarding@resend.dev>',
  },

  // Cloudflare Turnstile (bot protection — free, unlimited)
  turnstile: {
    secretKey: process.env.TURNSTILE_SECRET_KEY || '',
    // When empty, verification is skipped (dev mode / not yet configured)
  },

  // Nepali payment gateways (V4) — eSewa & Khalti
  payments: {
    frontendUrl: process.env.PUBLIC_FRONTEND_URL || 'http://localhost:3000',
    esewa: {
      baseUrl: process.env.ESEWA_BASE_URL || 'https://rc-epay.esewa.com.np', // rc- = sandbox; prod: https://epay.esewa.com.np
      productCode: process.env.ESEWA_PRODUCT_CODE || 'EPAYTEST',
      secretKey: process.env.ESEWA_SECRET_KEY || '8gBm/:&EnhH.1/q', // sandbox key
      successUrl: process.env.ESEWA_SUCCESS_URL || 'http://localhost:5000/api/billing/esewa/verify',
      failureUrl: process.env.ESEWA_FAILURE_URL || 'http://localhost:3000/billing?status=failed',
    },
    khalti: {
      baseUrl: process.env.KHALTI_BASE_URL || 'https://a.khalti.com/api/v2', // a. = sandbox; prod: https://khalti.com/api/v2
      secretKey: process.env.KHALTI_SECRET_KEY || '',
      websiteUrl: process.env.PUBLIC_BACKEND_URL || 'http://localhost:5000',
    },
  },

  // Keep-alive: prevents Render free instances from sleeping
  keepAlive: {
    enabled: process.env.KEEP_ALIVE !== 'false', // on by default in production
    intervalMs: parseInt(process.env.KEEP_ALIVE_INTERVAL_MS || String(14 * 60 * 1000), 10),
    selfUrl: process.env.PUBLIC_BACKEND_URL || process.env.RENDER_EXTERNAL_URL || '',
    // External cron pinger URL — see startKeepAlive() for why this matters
    cronPingUrl: process.env.KEEP_ALIVE_CRON_URL || '',
  },

  // Embeddings: local MiniLM via HuggingFace Inference API (free) or fallback hash
  embeddings: {
    hfToken: process.env.HUGGINGFACE_API_KEY || '',
    hfModel: process.env.HF_EMBEDDING_MODEL || 'sentence-transformers/all-MiniLM-L6-v2',
    dimensions: 384,
  },

  corsOrigins: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  freeTierQuotas: {
    messagesPerMonth: parseInt(process.env.QUOTA_MESSAGES_PER_MONTH || '200', 10),
    documentsMax: parseInt(process.env.QUOTA_DOCUMENTS_MAX || '10', 10),
    bookingsPerMonth: parseInt(process.env.QUOTA_BOOKINGS_PER_MONTH || '50', 10),
  },

  rag: {
    chunkSize: 400,   // tokens approx
    chunkOverlap: 50,
    topK: 5,
  },
};

module.exports = config;
