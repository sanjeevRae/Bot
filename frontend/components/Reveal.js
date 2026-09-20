import { useEffect, useRef, useState } from 'react';

/**
 * Scroll reveal — fade-in + fly-up as an element scrolls into view.
 *
 * Design constraints (deliberate):
 *  - No library (AOS hides elements via SSR CSS, which delays first paint and
 *    hurts LCP). Here the SSR markup is fully visible; nothing is hidden until
 *    after hydration, and only if the element is already BELOW the fold. The
 *    hero and anything on screen at load never animate, so LCP is untouched.
 *  - Reveals fire once. No re-hiding on scroll up, no bouncing, no long delays —
 *    `delay` is only a small stagger (ms) for sibling cards in a grid.
 *  - Respects prefers-reduced-motion and degrades to plain static content when
 *    IntersectionObserver is unavailable (old browsers, bots, tests).
 *
 * Extra props (onMouseEnter, key handlers, aria-*, ...) are forwarded to the
 * rendered element, so this can act as the grid item / card itself.
 */
export default function Reveal({
  as: Tag = 'div',
  delay = 0,
  className = '',
  children,
  ...rest
}) {
  const ref = useRef(null);
  // static = rendered plain (never animated); hidden/shown = the reveal pair.
  const [reveal, setReveal] = useState('static');

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion || typeof IntersectionObserver === 'undefined') return undefined;

    // LCP guard: only hide elements whose top edge is below the viewport.
    // Content in (or nearly in) view at load keeps painting immediately.
    if (el.getBoundingClientRect().top <= window.innerHeight * 0.92) return undefined;

    setReveal('hidden');
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setReveal('shown');
          io.disconnect(); // fire once — scrolling back up never re-hides
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const hidden = reveal === 'hidden';
  return (
    <Tag
      ref={ref}
      className={`${className} ${
        reveal === 'static'
          ? ''
          : 'transition-[opacity,transform] duration-700 ease-out motion-reduce:transition-none motion-reduce:transform-none'
      } ${hidden ? 'opacity-0 [transform:translateY(18px)]' : 'opacity-100 [transform:translateY(0)]'}`}
      // No transition while hiding, so the just-below-fold tuck-away never
      // flickers; the delay staggers grid siblings on the way in.
      style={hidden ? { transition: 'none' } : delay ? { transitionDelay: `${delay}ms` } : undefined}
      {...rest}
    >
      {children}
    </Tag>
  );
}