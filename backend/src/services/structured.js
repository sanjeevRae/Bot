/**
 * Structured business facts → retrievable text.
 *
 * A merchant knows their opening hours, delivery fee and price list far more
 * precisely than any crawl of their website will ever express them. Phase B of
 * the knowledge-base plan lets them type those facts in, and this module turns
 * the form payload into text the retriever can match:
 *
 *   - each fact becomes a short "Label: value" line, which is exactly the shape
 *     a lexical scorer (services/rag.js) and a small LLM both handle best,
 *   - each Q&A pair becomes an explicit "Q: … / A: …" block,
 *   - the API never trusts the shapes blindly: unknown keys are dropped and
 *     lengths are capped so a paste of 200 KB cannot blow up the prompt.
 */

/** Labels shown in the generated text, in the order they are emitted. */
const FACT_LABELS = {
  business_name: 'Business name',
  category: 'Type of business',
  phone: 'Phone',
  whatsapp: 'WhatsApp',
  email: 'Email',
  address: 'Address',
  map_url: 'Map link',
  website: 'Website',
  booking_url: 'Booking link',
  payment_methods: 'Payment methods',
  delivery: 'Delivery',
  delivery_fee: 'Delivery fee',
  coverage: 'Service area',
  return_policy: 'Return / refund policy',
  cancellation_policy: 'Cancellation policy',
  languages: 'Languages spoken',
  parking: 'Parking',
  notes: 'Other details',
};

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const MAX_TEXT = 600;   // per free-text field
const MAX_SHORT = 200;  // per one-line field
const MAX_SERVICES = 60;
const MAX_FAQS = 60;

function clean(value, max) {
  if (value === null || value === undefined) return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

/** Opening-hours values are kept verbatim, just tidied. */
function cleanHours(value) {
  const s = clean(value, 60);
  if (!s) return '';
  if (/^(closed|off|holiday)$/i.test(s)) return 'Closed';
  if (/^24\s*(h|hr|hrs|hours)?s?$/i.test(s)) return 'Open 24 hours';
  return s.replace(/\s*[-–—]\s*/, '–');
}

function formatHours(hours) {
  if (!hours || typeof hours !== 'object') return '';
  const lines = [];
  for (const day of DAYS) {
    const value = cleanHours(hours[day]);
    if (!value) continue;
    lines.push(`${day.charAt(0).toUpperCase()}${day.slice(1)}: ${value}`);
  }
  if (!lines.length) return '';
  // "Daily 9:00–22:00" is both friendlier to read than seven identical lines
  // and a single strong signal for the retriever to match.
  const times = new Set(lines.map((l) => l.split(': ').slice(1).join(': ')));
  if (times.size === 1 && lines.length >= 5) {
    return `Opening hours: Daily ${[...times][0]}`;
  }
  return `Opening hours:\n${lines.join('\n')}`;
}

function formatServices(services) {
  if (!Array.isArray(services)) return '';
  const lines = [];
  for (const item of services.slice(0, MAX_SERVICES)) {
    if (!item) continue;
    const name = clean(item.name ?? item.service ?? item.item, MAX_SHORT);
    if (!name) continue;
    const price = clean(item.price, 60);
    const duration = clean(item.duration, 60);
    const description = clean(item.description ?? item.details, MAX_SHORT);
    const tail = [price && `Price: ${price}`, duration && `Duration: ${duration}`, description]
      .filter(Boolean)
      .join(' · ');
    lines.push(tail ? `${name} — ${tail}` : name);
  }
  if (!lines.length) return '';
  return `Services and prices:\n${lines.join('\n')}`;
}

function formatFaqs(faqs) {
  if (!Array.isArray(faqs)) return '';
  const blocks = [];
  for (const item of faqs.slice(0, MAX_FAQS)) {
    if (!item) continue;
    const question = clean(item.question ?? item.q, MAX_SHORT);
    const answer = clean(item.answer ?? item.a, MAX_TEXT);
    if (!question || !answer) continue;
    blocks.push(`Q: ${question}\nA: ${answer}`);
  }
  return blocks.join('\n\n');
}

/**
 * Build the document text for a structured submission.
 *
 * @param {object} payload
 * @returns {{text:string, title:string, sections:{facts:number, hours:boolean, services:number, faqs:number}}}
 */
function buildStructuredText(payload = {}) {
  const p = payload || {};
  const title = clean(p.title, 120) || 'Business details';
  const parts = [];
  const counts = { facts: 0, hours: false, services: 0, faqs: 0 };

  for (const [key, label] of Object.entries(FACT_LABELS)) {
    const value = clean(p[key], MAX_TEXT);
    if (!value) continue;
    parts.push(`${label}: ${value}`);
    counts.facts += 1;
  }

  // Free-form label/value rows the UI lets merchants add for anything not listed.
  if (Array.isArray(p.facts)) {
    for (const row of p.facts.slice(0, 40)) {
      const label = clean(row?.label, MAX_SHORT);
      const value = clean(row?.value, MAX_TEXT);
      if (!label || !value) continue;
      parts.push(`${label}: ${value}`);
      counts.facts += 1;
    }
  }

  const hours = formatHours(p.hours);
  if (hours) {
    parts.push(hours);
    counts.hours = true;
  }

  const services = formatServices(p.services);
  if (services) {
    parts.push(services);
    counts.services = Math.min((p.services || []).length, MAX_SERVICES);
  }

  const faqs = formatFaqs(p.faqs);
  if (faqs) {
    parts.push(faqs);
    counts.faqs = Math.min((p.faqs || []).length, MAX_FAQS);
  }

  const extra = clean(p.extra_text, 6000);
  if (extra) parts.push(extra);

  return { text: parts.join('\n\n').trim(), title, sections: counts };
}

/**
 * Ready-made starter facts per industry, so a merchant edits their own reality
 * instead of facing a blank form. Served to the dashboard's template picker via
 * GET /api/knowledge/structured.
 */
const INDUSTRY_TEMPLATES = {
  restaurant: {
    label: 'Restaurant / café',
    facts: { category: 'Restaurant', delivery: 'Delivery available', payment_methods: 'Cash, eSewa, Khalti, card' },
    services: [
      { name: 'Chicken momo (steam)', price: 'Rs. 220' },
      { name: 'Veg chowmein', price: 'Rs. 180' },
      { name: 'Set lunch (dal bhat)', price: 'Rs. 350' },
    ],
    faqs: [
      { question: 'Do you deliver?', answer: 'Yes — inside Ring Road, about 45 minutes, Rs. 80 delivery fee.' },
      { question: 'Can I book a table?', answer: 'Yes. Tell me the date, time and number of guests and I will book it.' },
    ],
  },
  salon: {
    label: 'Salon / spa',
    facts: { category: 'Salon', payment_methods: 'Cash, eSewa, Khalti' },
    services: [
      { name: 'Haircut (men)', price: 'Rs. 600', duration: '30 min' },
      { name: 'Hair colour', price: 'Rs. 3,500', duration: '90 min' },
      { name: 'Facial', price: 'Rs. 2,000', duration: '60 min' },
    ],
    faqs: [
      { question: 'Do I need an appointment?', answer: 'Walk-ins are welcome, but an appointment means no waiting.' },
      { question: 'Do you take card?', answer: 'Yes — card, eSewa, Khalti and cash.' },
    ],
  },
  retail: {
    label: 'Shop / retail',
    facts: {
      category: 'Retail shop',
      delivery: 'Home delivery available',
      delivery_fee: 'Rs. 100 inside the valley',
      return_policy: 'Exchange within 7 days with the receipt',
      payment_methods: 'Cash, eSewa, Khalti, card',
    },
    services: [],
    faqs: [
      { question: 'How long does delivery take?', answer: 'Same day inside Kathmandu valley, 2–3 days outside.' },
      { question: 'Can I return an item?', answer: 'Yes, within 7 days with the receipt.' },
    ],
  },
  clinic: {
    label: 'Clinic / doctor',
    facts: { category: 'Clinic', payment_methods: 'Cash, card' },
    services: [
      { name: 'General consultation', price: 'Rs. 800', duration: '15 min' },
      { name: 'Follow-up visit', price: 'Rs. 500', duration: '10 min' },
    ],
    faqs: [
      { question: 'How do I book an appointment?', answer: 'Tell me your name, phone number and preferred time and I will book it.' },
      { question: 'Do you have emergency service?', answer: 'Yes, 24/7 — call the clinic number.' },
    ],
  },
  hotel: {
    label: 'Hotel / homestay',
    facts: { category: 'Hotel', payment_methods: 'Cash, card, eSewa' },
    services: [
      { name: 'Deluxe room (per night)', price: 'Rs. 4,500' },
      { name: 'Standard room (per night)', price: 'Rs. 3,000' },
      { name: 'Breakfast', price: 'Rs. 500' },
    ],
    faqs: [
      { question: 'What is the check-in time?', answer: 'Check-in from 1 PM, check-out before 11 AM.' },
      { question: 'Is breakfast included?', answer: 'Breakfast is included in deluxe rooms.' },
    ],
  },
  services: {
    label: 'Agency / professional services',
    facts: { category: 'Professional services', payment_methods: 'Bank transfer, eSewa, Khalti' },
    services: [
      { name: 'Consultation call', price: 'Rs. 2,000', duration: '60 min' },
      { name: 'Monthly retainer', price: 'Rs. 25,000' },
    ],
    faqs: [
      { question: 'How do we start working together?', answer: 'Book a consultation call and we will send a scope and a quote.' },
      { question: 'What are your payment terms?', answer: '50% in advance, 50% on delivery.' },
    ],
  },
};

module.exports = { buildStructuredText, INDUSTRY_TEMPLATES, FACT_LABELS, DAYS };
