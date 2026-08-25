import Link from 'next/link';
import DemoWidget from '../components/DemoWidget';

/* Inline SVG icon set (Lucide-style strokes) */
const Icon = ({ children }) => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="text-brand-600"
  >
    {children}
  </svg>
);

const Icons = {
  brain: (
    <Icon>
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
    </Icon>
  ),
  calendar: (
    <Icon>
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
    </Icon>
  ),
  target: (
    <Icon>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </Icon>
  ),
  puzzle: (
    <Icon>
      <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
    </Icon>
  ),
  shield: (
    <Icon>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
      <path d="m9 12 2 2 4-4" />
    </Icon>
  ),
  zap: (
    <Icon>
      <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
    </Icon>
  ),
};

/* Reusable section header */
function SectionHeader({ eyebrow, title, text, dark = false }) {
  return (
    <div className="mx-auto mb-12 max-w-2xl text-center sm:mb-16">
      {eyebrow && (
        <p className={`eyebrow mb-3 ${dark ? '!text-brand-300' : ''}`}>{eyebrow}</p>
      )}
      <h2 className={`h-display mb-4 text-3xl leading-tight sm:text-4xl ${dark ? 'text-white' : ''}`}>
        {title}
      </h2>
      {text && (
        <p className={`mx-auto max-w-lg text-[15px] leading-relaxed ${dark ? 'text-gray-400' : 'text-ink-500'}`}>
          {text}
        </p>
      )}
    </div>
  );
}

export default function Home() {
  const demoOrgId = process.env.NEXT_PUBLIC_DEMO_ORG_ID;

  return (
    <main>
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 pb-10 pt-12 text-center sm:px-6 sm:pb-10 sm:pt-12">
        <span className="chip mb-6">Free trial · No credit card required</span>
        <h1 className="h-display mx-auto mb-5 max-w-3xl text-4xl leading-[1.1] sm:text-5xl md:text-[56px]">
          AI Assistant That Sells,
          <br />
          Books &amp; Never Sleeps
        </h1>
        <p className="mx-auto mb-8 max-w-xl text-base leading-relaxed text-ink-500 sm:text-lg">
          From first question to confirmed booking — let AI handle your customers
          around the clock, seamlessly.
        </p>
        <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link href="/signup" className="btn-primary w-full px-7 py-3 sm:w-auto">
            Get Started Free
          </Link>
          <Link href="/#how" className="btn-secondary w-full px-7 py-3 sm:w-auto">
            See how it works
          </Link>
        </div>
      </section>

      {/* Hero image */}
      <img
        src="https://res.cloudinary.com/dngbvnleh/image/upload/v1787640706/Your_paragraph_text_elscbq.png"
        alt="Chitra AI assistant"
        className="block w-full"
      />

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
        <SectionHeader
          eyebrow="Why Chitra"
          title="Everything your business needs"
          text="One assistant that learns your business and works for you 24/7."
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
          {[
            { icon: Icons.brain, title: 'Learns your business', text: 'Point it at your website, upload a PDF, or paste FAQs. It builds its own knowledge base.' },
            { icon: Icons.calendar, title: 'Books appointments', text: 'Customers book right in the chat. You get notified instantly.' },
            { icon: Icons.target, title: 'Captures leads', text: 'Every interested visitor becomes a lead in your dashboard.' },
            { icon: Icons.puzzle, title: 'Installs anywhere', text: 'One script tag for any website, WordPress plugin, or QR code link.' },
            { icon: Icons.shield, title: 'Private by design', text: 'Row-level security keeps every business’s data fully isolated.' },
            { icon: Icons.zap, title: 'Fast & free', text: 'Powered by Groq’s lightning inference. Generous free tier, upgrade only when you grow.' },
          ].map((f) => (
            <div key={f.title} className="card p-6 transition-colors duration-150 hover:border-gray-300">
              <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-brand-100 bg-brand-50">
                {f.icon}
              </div>
              <h3 className="mb-1.5 text-[15px] font-semibold text-ink-900">{f.title}</h3>
              <p className="text-sm leading-relaxed text-ink-500">{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="border-y border-gray-200 bg-gray-50 px-5 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <SectionHeader
            eyebrow="Get started"
            title="Live in 3 minutes"
            text="No developers, no setup calls, no credit card. Three steps and your assistant is talking to customers."
          />
          <div className="grid gap-4 md:grid-cols-3 md:gap-6">
            {[
              ['1', 'Sign up & describe your business', 'Create a free account and tell us your industry — restaurant, salon, clinic or anything else.'],
              ['2', 'Teach it your business', 'Crawl your website, upload a PDF menu, or paste FAQs. Chitra builds its own knowledge base in seconds.'],
              ['3', 'Copy one line to your website', 'Paste a single script tag or share your QR link. Your assistant starts working immediately.'],
            ].map(([n, title, text]) => (
              <div key={n} className="card p-6 sm:p-7">
                <div className="mb-4 flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">
                  {n}
                </div>
                <h3 className="mb-2 text-[15px] font-semibold text-ink-900">{title}</h3>
                <p className="text-sm leading-relaxed text-ink-500">{text}</p>
              </div>
            ))}
          </div>
          <div className="mt-10 text-center">
            <Link href="/signup" className="btn-primary px-7 py-3">
              Start now — it&apos;s free
            </Link>
          </div>
        </div>
      </section>

      {/* Feature showcase */}
      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
        <SectionHeader
          eyebrow="Features"
          title="Your business, on autopilot"
          text="Chitra learns your business once and works 24/7 — answering questions, capturing leads, booking appointments."
        />

        {/* Panel 1 — chat mock */}
        <div className="card mb-6 grid overflow-hidden md:grid-cols-2">
          <div className="flex flex-col justify-center p-7 sm:p-10">
            <h3 className="h-display mb-3 text-2xl sm:text-3xl">
              A chatbot that actually knows you
            </h3>
            <p className="mb-8 text-[15px] leading-relaxed text-ink-500">
              Feed it your website, menu or price list once. Chitra answers customer
              questions instantly and accurately — 24/7, in any language your
              customers speak.
            </p>
            <Link href="/signup" className="btn-primary w-fit px-5 py-2.5">
              Try it free
            </Link>
          </div>

          <div className="border-t border-gray-200 bg-gray-50 p-5 sm:p-7 md:border-l md:border-t-0">
            <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                <span className="text-sm font-medium text-ink-900">Chitra Assistant</span>
                <span className="chip-success">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span> Online
                </span>
              </div>
              <div className="space-y-2.5 p-4">
                <div className="max-w-[85%] rounded-lg rounded-bl-sm bg-gray-100 px-3.5 py-2.5 text-[13px] text-ink-700">
                  Hi! Is the salon open this Sunday?
                </div>
                <div className="ml-auto max-w-[85%] rounded-lg rounded-br-sm bg-brand-600 px-3.5 py-2.5 text-[13px] text-white">
                  Yes! We&apos;re open 10am–6pm this Sunday. Would you like me to book you a slot?
                </div>
                <div className="max-w-[85%] rounded-lg rounded-bl-sm bg-gray-100 px-3.5 py-2.5 text-[13px] text-ink-700">
                  Yes, 2pm for a haircut please
                </div>
                <div className="ml-auto max-w-[85%] rounded-lg rounded-br-sm bg-brand-600 px-3.5 py-2.5 text-[13px] text-white">
                  Done! You&apos;re booked for Sunday at 2pm. See you then.
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Panels 2 & 3 */}
        <div className="grid gap-6 md:grid-cols-2">
          {/* Bookings */}
          <div className="card overflow-hidden">
            <div className="p-7 sm:p-8">
              <h3 className="h-display mb-2 text-xl sm:text-2xl">Smart bookings</h3>
              <p className="text-sm leading-relaxed text-ink-500">
                Customers book right inside the chat. You get an instant
                notification with every new appointment.
              </p>
            </div>
            <div className="border-t border-gray-200 bg-gray-50 p-5 sm:p-6">
              <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
                <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                  <span className="text-sm font-medium text-ink-900">Today&apos;s bookings</span>
                  <span className="chip-accent">4 new</span>
                </div>
                <div className="divide-y divide-gray-100">
                  {[
                    ['Maya Sharma', 'Haircut · 2:00 PM', true],
                    ['Rohan Patel', 'Table for 4 · 7:30 PM', true],
                    ['Aisha K.', 'Consultation · 4:15 PM', false],
                  ].map(([name, detail, confirmed]) => (
                    <div key={name} className="flex items-center gap-3 px-4 py-3">
                      <img
                        src={`https://i.pravatar.cc/64?img=${(name.length * 7) % 70}`}
                        alt={name}
                        className="h-8 w-8 rounded-full object-cover"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-ink-900">{name}</p>
                        <p className="text-xs text-ink-400">{detail}</p>
                      </div>
                      <span className={confirmed ? 'chip-success' : 'chip-warning'}>
                        {confirmed ? 'Confirmed' : 'Pending'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Leads */}
          <div className="card overflow-hidden">
            <div className="p-7 sm:p-8">
              <h3 className="h-display mb-2 text-xl sm:text-2xl">Never lose a lead</h3>
              <p className="text-sm leading-relaxed text-ink-500">
                Every visitor who shares their contact info is saved
                automatically — ready for you to follow up.
              </p>
            </div>
            <div className="border-t border-gray-200 bg-gray-50 p-5 sm:p-6">
              <div className="space-y-3">
                {[
                  ['Daniel Osei', 'Asked about pricing for a team of 12', '2m ago'],
                  ['Priya Nair', 'Wants a demo next week', '1h ago'],
                ].map(([name, note, time], i) => (
                  <div key={name} className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                    <img
                      src={`https://i.pravatar.cc/64?img=${(i + 3) * 11}`}
                      alt={name}
                      className="h-9 w-9 rounded-full object-cover"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium text-ink-900">{name}</p>
                      <p className="truncate text-xs text-ink-500">{note}</p>
                    </div>
                    <span className="text-xs text-ink-400">{time}</span>
                  </div>
                ))}
                <div className="rounded-lg border border-dashed border-gray-300 bg-white p-4 text-center">
                  <p className="text-xs text-ink-400">+ 12 more captured this week</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Integrations */}
      <section id="integrations" className="bg-ink-900 px-5 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <SectionHeader
            dark
            eyebrow="Integrations"
            title="Don't replace. Integrate."
            text="Chitra fits into the tools you already use — no migration, no learning curve. Connect in one click."
          />
          <div className="space-y-3 sm:space-y-4">
            {[
              ['whatsapp', 'notion', 'trello', 'stripe', 'gmail', 'googledrive', 'calcom', 'zapier'],
              ['asana', 'mailchimp', 'hubspot', 'zoho', 'googlemeet', 'clickup', 'shopify', 'discord'],
            ].map((row, rowIdx) => (
              <div key={rowIdx} className="flex flex-wrap justify-center gap-3 sm:gap-4">
                {row.map((slug) => (
                  <div
                    key={slug}
                    title={slug}
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 sm:h-14 sm:w-14"
                  >
                    <img
                      src={`https://cdn.simpleicons.org/${slug}/ffffff`}
                      alt={slug}
                      loading="lazy"
                      className="h-5 w-5 opacity-80 sm:h-6 sm:w-6"
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="mt-10 text-center">
            <Link href="/signup" className="btn-link !text-brand-300 hover:!text-white">
              All integrations <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      </section>

      {/* Testimonial */}
      <section className="mx-auto max-w-3xl px-5 py-16 text-center sm:px-6 sm:py-24">
        <blockquote className="h-display mx-auto mb-8 max-w-2xl text-2xl leading-snug sm:text-3xl">
          Chitra answers our customers while we sleep. It booked 40+ appointments
          in the first month alone — and we didn&apos;t hire anyone.
        </blockquote>
        <img
          src="https://i.pravatar.cc/96?img=32"
          alt="Anjali Mehta"
          className="mx-auto mb-3 h-12 w-12 rounded-full object-cover ring-2 ring-gray-200"
        />
        <p className="text-sm font-semibold text-ink-900">Anjali Mehta</p>
        <p className="text-xs text-ink-400">Owner, Bloom Salon &amp; Spa</p>
      </section>

      {/* CTA banner */}
      <section className="border-t border-gray-200 bg-gray-50 px-5 py-16 sm:px-6 sm:py-20">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 md:flex-row md:items-center">
          <div>
            <h2 className="h-display mb-2 max-w-md text-3xl leading-tight sm:text-4xl">
              Discover the full scale of Chitra capabilities
            </h2>
            <p className="max-w-md text-[15px] text-ink-500">
              Set up in minutes. Free to start. Scale when you grow.
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
            <Link href="/login" className="btn-secondary px-6 py-3">
              Get a Demo
            </Link>
            <Link href="/signup" className="btn-primary px-6 py-3">
              Start for Free
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 bg-white px-5 pb-8 pt-14 sm:px-6">
        <div className="mx-auto max-w-6xl">
          {/* Brand — full width above the link row */}
          <div className="mb-10">
            <div className="mb-4 flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">C</span>
              <span className="text-[15px] font-semibold tracking-tight text-ink-900">Chitra AI</span>
            </div>
            <p className="mb-4 text-sm text-ink-500">Your business, answered 24/7.</p>
            <p className="mb-1.5 flex items-center gap-2.5 text-sm text-ink-500">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></svg>
              Kapan, Kathmandu, Nepal
            </p>
            <p className="flex items-center gap-2.5 text-sm text-ink-500">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="16" x="2" y="4" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" /></svg>
              <a href="mailto:info@chitratech.com" className="transition-colors hover:text-ink-900">info@chitratech.com</a>
            </p>
          </div>

          {/* Link columns — side by side on all screens */}
          <div className="grid grid-cols-3 gap-4 sm:gap-8">
            {[
              ['Product', [
                ['Features', '/#features'],
                ['Integrations', '/#integrations'],
                ['How it works', '/#how'],
                ['Dashboard', '/dashboard'],
              ]],
              ['For Business', [
                ['Restaurants', '/signup'],
                ['Salons & Spas', '/signup'],
                ['Clinics', '/signup'],
                ['Retail Stores', '/signup'],
              ]],
              ['Resources', [
                ['Pricing', '/#pricing'],
                ['Bookings', '/bookings'],
                ['Leads', '/leads'],
                ['Settings', '/settings'],
              ]],
            ].map(([title, links]) => (
              <div key={title}>
                <p className="mb-4 text-sm font-semibold text-ink-900">{title}</p>
                <ul className="space-y-2.5">
                  {links.map(([label, href]) => (
                    <li key={label}>
                      <Link href={href} className="text-[13px] text-ink-500 transition-colors hover:text-ink-900 sm:text-sm">
                        {label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-gray-200 pt-6 sm:flex-row">
            <p className="text-xs text-ink-400">© Copyright 2026 Chitra AI. All rights reserved.</p>
            <div className="flex gap-4">
              {[
                ['Facebook', 'https://www.facebook.com/people/Chitra-Tech/61589090079956/', 'https://s.magecdn.com/social/tc-facebook.svg'],
                ['TikTok', 'https://www.tiktok.com/@chitratech', 'https://s.magecdn.com/social/tc-tiktok.svg'],
                ['Instagram', 'https://www.instagram.com/chitra.tech', 'https://s.magecdn.com/social/tc-instagram.svg'],
                ['LinkedIn', 'https://www.linkedin.com/company/chitratech', 'https://s.magecdn.com/social/tc-linkedin.svg'],
              ].map(([name, href, icon]) => (
                <a key={name} href={href} target="_blank" rel="noopener noreferrer" aria-label={name} title={name} className="transition-opacity hover:opacity-70">
                  <img src={icon} alt={name} width="18" height="18" loading="lazy" />
                </a>
              ))}
            </div>
          </div>
        </div>
      </footer>
      {demoOrgId && <DemoWidget orgId={demoOrgId} />}
    </main>
  );
}
