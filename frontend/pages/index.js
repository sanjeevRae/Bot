import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import DemoWidget from '../components/DemoWidget';

/* Feature glyphs — the exact artwork supplied for this section: leaf, sparkle,
   lightning, star. Each viewBox is tight to its own path, so only the ink height
   has to be set; heights are in px at the 14px body this section uses. */
const FeatureIcons = {
  leaf: (
    <svg viewBox="0.1445 3.4277 15.7143 17.1429" className="h-[15px] w-auto fill-current" aria-hidden="true">
      <path d="M15.8588 4.14202V5.92773C15.8563 7.47794 15.2611 8.9685 14.1952 10.0941C13.1293 11.2197 11.6733 11.8951 10.1255 11.982C10.0327 10.0812 9.21807 8.28753 7.84782 6.96695C8.33226 5.91213 9.10878 5.0182 10.0855 4.39097C11.0621 3.76374 12.1981 3.42947 13.3588 3.42773H15.1445C15.334 3.42773 15.5157 3.50299 15.6496 3.63694C15.7836 3.7709 15.8588 3.95258 15.8588 4.14202ZM2.64453 6.28488H0.858817C0.669377 6.28488 0.487695 6.36013 0.353741 6.49409C0.219786 6.62804 0.144531 6.80972 0.144531 6.99916V8.78488C0.146422 10.3945 0.786695 11.9377 1.9249 13.0759C3.0631 14.2141 4.6063 14.8544 6.21596 14.8563H7.28739V19.8563C7.28739 20.0457 7.36264 20.2274 7.4966 20.3614C7.63055 20.4953 7.81223 20.5706 8.00167 20.5706C8.19111 20.5706 8.3728 20.4953 8.50675 20.3614C8.64071 20.2274 8.71596 20.0457 8.71596 19.8563V12.3563C8.71407 10.7466 8.0738 9.20345 6.93559 8.06525C5.79739 6.92704 4.25419 6.28677 2.64453 6.28488Z" />
    </svg>
  ),
  sparkle: (
    <svg viewBox="0 2.3613 16.2775 16.2774" className="h-[14px] w-auto fill-current" aria-hidden="true">
      <path d="M15.5807 9.64214C12.2742 8.94898 9.6898 6.36456 8.99674 3.058C8.91161 2.6521 8.5536 2.36133 8.13875 2.36133C7.7239 2.36133 7.36589 2.6521 7.28081 3.05806C6.58771 6.36456 4.00329 8.94893 0.696782 9.64198C0.290828 9.72706 0 10.0851 0 10.4999C0 10.9147 0.290774 11.2728 0.696782 11.3579C4.00324 12.051 6.58755 14.6354 7.28065 17.9419C7.36573 18.3478 7.72374 18.6387 8.13859 18.6387C8.55339 18.6387 8.91145 18.3479 8.99653 17.9419C9.68969 14.6354 12.2742 12.051 15.5807 11.358C15.9866 11.2729 16.2775 10.9149 16.2775 10.5001C16.2774 10.0853 15.9866 9.72722 15.5807 9.64214Z" />
    </svg>
  ),
  bolt: (
    <svg viewBox="-0.0107 1.248 13.873 17.1486" className="h-[15px] w-auto fill-current" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8.93812 1.33905C9.05079 1.40549 9.13922 1.51 9.18929 1.63589C9.23936 1.76179 9.24819 1.90182 9.21438 2.03366L7.68147 7.98752H13.2744C13.3869 7.98753 13.4969 8.02235 13.591 8.08771C13.685 8.15308 13.759 8.24613 13.8038 8.35543C13.8486 8.46473 13.8623 8.58551 13.8432 8.70294C13.824 8.82036 13.7729 8.92931 13.6962 9.01638L5.61603 18.1881C5.52803 18.2882 5.41087 18.3542 5.28331 18.3754C5.15574 18.3966 5.02514 18.3719 4.91238 18.3053C4.79963 18.2386 4.71123 18.1338 4.66134 18.0076C4.61145 17.8814 4.60295 17.7412 4.63718 17.6092L6.1701 11.6562H0.577115C0.464639 11.6562 0.354616 11.6214 0.26057 11.556C0.166525 11.4906 0.0925563 11.3976 0.0477569 11.2883C0.00295745 11.179 -0.0107202 11.0582 0.00840534 10.9408C0.0275309 10.8234 0.078626 10.7144 0.15541 10.6273L8.23553 1.45564C8.32354 1.35589 8.44053 1.29021 8.56786 1.26908C8.69519 1.24796 8.82553 1.27259 8.93812 1.33905Z"
      />
    </svg>
  ),
  star: (
    <svg viewBox="0.416 2 16.168 15.3766" className="h-[14px] w-auto fill-current" aria-hidden="true">
      <path d="M8.5 2L11.2129 6.76598L16.584 7.87336L12.8896 11.9263L13.4962 17.3766L8.5 15.1155L3.50382 17.3766L4.11039 11.9263L0.416016 7.87336L5.78707 6.76598L8.5 2Z" />
    </svg>
  ),
};

/* Feature cards — module scope so the array identity is stable across renders
   (the indicator line indexes into it to find the hovered column). */
const FEATURES = [
  { icon: FeatureIcons.leaf, title: 'Learns your business', text: 'Point it at your website, upload a PDF, or paste FAQs. It builds its own knowledge base.' },
  { icon: FeatureIcons.sparkle, title: 'Books appointments', text: 'Customers book right in the chat. You get notified instantly.' },
  { icon: FeatureIcons.bolt, title: 'Captures leads', text: 'Every interested visitor becomes a lead in your dashboard.' },
  { icon: FeatureIcons.star, title: 'Installs anywhere', text: 'One script tag for any website, WordPress plugin, or QR code link.' },
];

/* Reusable section header */
function SectionHeader({ eyebrow, title, text, dark = false, eyebrowClassName = '' }) {
  return (
    <div className="mx-auto mb-12 max-w-2xl text-center sm:mb-16">
      {eyebrow && (
        <p className={`eyebrow mb-3 ${dark ? '!text-brand-300' : ''} ${eyebrowClassName}`}>{eyebrow}</p>
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
  // Which "Who it's for" row is hovered — drives the geometric marker spin.
  const [activeMarker, setActiveMarker] = useState(null);
  // Which feature card is hovered — drives its icon's spin-and-lift and the
  // indicator line under the grid.
  const [activeFeature, setActiveFeature] = useState(null);
  // Measured x/width of each feature column, so the indicator can slide between them.
  const featureGridRef = useRef(null);
  const featureTrackRef = useRef(null);
  const [featureCols, setFeatureCols] = useState(null);

  useEffect(() => {
    const grid = featureGridRef.current;
    const track = featureTrackRef.current;
    if (!grid || !track) return undefined;

    const measure = () => {
      const trackLeft = track.getBoundingClientRect().left;
      setFeatureCols(
        [...grid.children].map((col) => {
          const r = col.getBoundingClientRect();
          return { left: r.left - trackLeft, width: r.width };
        })
      );
    };

    measure();
    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure);
      ro.observe(grid);
    }
    window.addEventListener('resize', measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // No hover (or a hover leaving the grid) parks the indicator on the first card.
  const activeFeatureIndex = Math.max(0, FEATURES.findIndex((f) => f.title === activeFeature));
  const indicator = featureCols ? featureCols[activeFeatureIndex] : null;

  /* Scroll-driven hero-gif expansion:
     As the gif box scrolls into view it grows leftward until its left edge
     lines up with the h1's left edge (right edge stays pinned). Fully
     reversible when scrolling back up. Desktop only. */
  useEffect(() => {
    const gif = document.getElementById('hero-gif');
    const h1 = document.querySelector('main > section h1');
    if (!gif || !h1) return undefined;
    if (window.matchMedia('(max-width: 767px)').matches) return undefined;

    const column = gif.parentElement; // the md:w-[52%] wrapper
    let raf = 0;

    const update = () => {
      raf = 0;
      const colRect = column.getBoundingClientRect();
      const base = colRect.width; // resting width
      const full = colRect.right - h1.getBoundingClientRect().left; // left edge at h1's left
      const delta = Math.max(0, full - base);
      // 0 at the top of the page, 1 once scrolled ~600px (gif centered in view)
      const p = Math.min(1, Math.max(0, (window.scrollY - 120) / 480));
      gif.style.width = `${base + delta * p}px`;
      gif.style.transform = `translateX(-${delta * p}px)`; // grow leftward, right edge pinned
    };

    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
      gif.style.width = '';
    };
  }, []);

  return (
    <main>
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-5 pb-16 pt-10 sm:px-6 sm:pt-14 lg:pt-20">
        
        <h1 className="h-display max-w-5xl pt-12 pb-4 font-suisse text-4xl font-medium leading-[1.05] tracking-[-0.01em] sm:pt-6 sm:text-6xl lg:text-[80px]">
          Stop Losing Customers to Slow Replies.
        </h1>

        <Link
          href="/signup"
          className="mt-8 mb-10 inline-flex items-center justify-center rounded-lg bg-ink-900 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-900 focus-visible:ring-offset-2 sm:mt-14"
        >
          Get Started
        </Link>

        
        <div className="mt-28 flex sm:mt-32 md:mt-44 md:justify-end">
          <div className="w-full md:w-[52%]">
            <p className="text-justify text-[15px] leading-relaxed text-ink-900 sm:text-[17px]">
            You know how customers expect instant answers, even when your team
            is busy running the business?
            </p>

            <p className="mt-3 text-justify text-[15px] leading-relaxed text-ink-900 sm:text-[17px]">
              We help businesses capture more customers with AI-powered support,
              lead generation, and automated bookings — while saving time.
            </p>    

            {/* Gif div */}
            <div id="hero-gif" className="mt-8 aspect-video w-full overflow-hidden rounded-xl bg-ink-900 transition-[width,transform] duration-300 ease-out" />
          </div>
        </div>
      </section>




      {/* Who it's for */}
      <section className="mx-auto max-w-6xl px-5 pt-24 pb-16 sm:px-6 sm:pt-32 lg:pt-36">
        <div className="grid gap-12 md:grid-cols-2 md:gap-16">
          <div>
            <h2 className="h-display max-w-[7em] font-suisse text-[22px] font-medium leading-[1.1] tracking-[-0.01em] sm:text-[40px] lg:text-[48px]">
              Who Chitra AI is best for.
            </h2>
          </div>
          <ul className="space-y-[27px]">
            {[
              {
                markerPath: 'M12 0L24 12L12 24L0 12L12 0Z',
                markerSize: 'h-[0.68em] w-[0.68em]',
                lead: 'Entrepreneurs',
                text: ' ready to turn customer conversations into new opportunities, leads, bookings, and sales.',
              },
              {
                markerPath: 'M0 0L24 0L24 24L0 24L0 0Z',
                lead: 'Founders & startups',
                text: ' looking to scale customer engagement without adding more people to handle every conversation.',
              },
              {
                markerPath: 'M12 0L24 24L0 24L12 0Z',
                lead: 'Sales teams',
                text: ' wanting to respond faster, qualify leads automatically, and spend more time closing opportunities.',
              },
              {
                markerPath: 'M0 12A12 12 0 0 1 24 12A12 12 0 0 1 0 12Z',
                lead: 'Growing teams',
                text: ' ready to let AI handle repetitive conversations while they focus on building what comes next.',
              },
            ].map((item) => (
              <li key={item.lead} className="flex items-start gap-4 text-[14px] sm:text-[18px]">
                {/* Geometric marker */}
                <span aria-hidden="true" className="flex h-[1.35em] shrink-0 items-center [perspective:300px]">
                  <svg
                    viewBox="0 0 24 24"
                    className={`${
                      item.markerSize || 'h-[0.55em] w-[0.55em]'
                    } fill-ink-900 transition-transform duration-500 ease-out ${
                      activeMarker === item.lead ? '[transform:rotateY(180deg)]' : ''
                    }`}
                  >
                    <path d={item.markerPath} />
                  </svg>
                </span>
                <p
                  className="leading-[1.35] text-ink-500"
                  onMouseEnter={() => setActiveMarker(item.lead)}
                  onMouseLeave={() => setActiveMarker((cur) => (cur === item.lead ? null : cur))}
                >
                  <span className="font-semibold text-ink-900">{item.lead}</span>
                  {item.text}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div aria-hidden="true" className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
        <div className="h-px w-full bg-gray-200" />
      </div>

      {/* Features */}
      <section id="features" className="mx-auto max-w-6xl px-5 sm:px-6">
        <h2 className="h-display mb-19 max-w-[14em] font-suisse text-[24px] font-medium leading-[1.12] tracking-[-0.02em] sm:mb-16 sm:text-[30px] lg:mb-[74px] lg:text-[34px]">
          Everything your business needs
        </h2>
        <div
          ref={featureGridRef}
          className="grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-4"
          onMouseLeave={() => setActiveFeature(null)}
        >
          {FEATURES.map((f) => (
            <div key={f.title} onMouseEnter={() => setActiveFeature(f.title)}>
              {/* Mark turns a half turn left-to-right and holds a few px higher while the
                  card is hovered, then eases back to rest on leave. The perspective lives
                  on the row, so the turn reads in 3D instead of just flattening. */}
              <div className="mb-3.5 mt-5 flex h-[15px] items-end text-ink-900 [perspective:300px]">
                <span
                  className={`inline-flex transition-transform duration-500 ease-out ${
                    activeFeature === f.title ? '[transform:rotateY(180deg)_translateY(-4px)]' : ''
                  }`}
                >
                  {f.icon}
                </span>
              </div>
              <h3 className="mb-0.5 text-[17px] font-medium text-ink-900">{f.title}</h3>
              <p className="pb-10 text-[15.5px] leading-[1.5] text-ink-500">{f.text}</p>
            </div>
          ))}
        </div>

        {/* Indicator line — closes the section: hairline track flush with its bottom
            edge, with a marker that rests under the first column and slides to
            whichever column the pointer is over. */}
        <div ref={featureTrackRef} className="relative mt-10 h-px w-full bg-gray-200 sm:mt-14">
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute bottom-0 h-16 blur-2xl transition-opacity duration-500 ${
              activeFeature ? 'opacity-70' : 'opacity-0'
            }`}
            style={{
              left: indicator ? indicator.left : 0,
              width: indicator ? indicator.width : 0,
              background:
                'radial-gradient(58% 92% at 50% 100%, rgba(228,180,235,0.55), rgba(196,181,253,0.45) 45%, rgba(191,219,254,0.35) 72%, transparent 100%)',
            }}
          />
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute -top-px h-[2px] bg-ink-900 ${
              indicator ? 'transition-[left,width] duration-500 ease-out' : ''
            }`}
            style={{ left: indicator ? indicator.left : 0, width: indicator ? indicator.width : 0 }}
          />
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="border-y border-gray-200 bg-gray-50 px-5 py-16 sm:px-6 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <SectionHeader
            eyebrow="Get started"
            eyebrowClassName="!text-ink-900"
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
                <div className="mb-4 flex h-8 w-8 items-center justify-center rounded-full bg-ink-900 text-sm font-semibold text-white">
                  {n}
                </div>
                <h3 className="mb-2 text-[16px] font-semibold text-ink-900">{title}</h3>
                <p className="text-sm leading-relaxed text-ink-500">{text}</p>
              </div>
            ))}
          </div>
          <div className="mt-10 text-center">
            <Link
              href="/signup"
              className="btn-primary relative isolate overflow-hidden bg-transparent px-7 py-3 before:absolute before:inset-0 before:-z-10 before:bg-ink-900 after:absolute after:inset-0 after:-z-10 after:bg-gray-600 after:opacity-0 after:transition-opacity after:duration-300 after:ease-out hover:after:opacity-100 focus-visible:ring-ink-900"
            >
              Start now — it&apos;s free
            </Link>
          </div>
        </div>
      </section>

      {/* Feature showcase */}
      <section className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-24">
        <SectionHeader
          eyebrow="Features"
          eyebrowClassName="!text-ink-900"
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
            <Link
              href="/signup"
              className="btn-primary relative isolate w-fit overflow-hidden bg-transparent px-5 py-2.5 before:absolute before:inset-0 before:-z-10 before:bg-ink-900 after:absolute after:inset-0 after:-z-10 after:bg-gray-600 after:opacity-0 after:transition-opacity after:duration-300 after:ease-out hover:after:opacity-100 focus-visible:ring-ink-900"
            >
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
                <div className="ml-auto max-w-[85%] rounded-lg rounded-br-sm bg-blue-500 px-3.5 py-2.5 text-[13px] text-white">
                  Yes! We&apos;re open 10am–6pm this Sunday. Would you like me to book you a slot?
                </div>
                <div className="max-w-[85%] rounded-lg rounded-bl-sm bg-gray-100 px-3.5 py-2.5 text-[13px] text-ink-700">
                  Yes, 2pm for a haircut please
                </div>
                <div className="ml-auto max-w-[85%] rounded-lg rounded-br-sm bg-blue-500 px-3.5 py-2.5 text-[13px] text-white">
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
              <img src="/logo.png" alt="Chitra AI logo" className="h-8 w-8 rounded-lg object-contain" />
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
                ['Engagement', '/engagement'],
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
