"use client";
// Motion gates for the landing's client plates. Both default to "no motion":
// the server renders each plate's final frame, and a plate only starts to
// animate on the client once it knows the viewer allows motion and the plate
// is actually on screen (so nothing ticks offscreen or in a background tab).
import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mq = window.matchMedia(QUERY);
  mq.addEventListener?.('change', onChange);
  return () => mq.removeEventListener?.('change', onChange);
}

function clientSnapshot(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true;
  return window.matchMedia(QUERY).matches;
}

/** True when the viewer asked for reduced motion (and always on the server). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, clientSnapshot, () => true);
}

/** True while the element is at least partly in the viewport. */
export function useInView(ref: RefObject<Element | null>): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      setInView(entries.some((e) => e.isIntersecting));
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}

/** Animate only when motion is allowed and the plate is visible. */
export function useAnimate(ref: RefObject<Element | null>): boolean {
  const reduced = useReducedMotion();
  const inView = useInView(ref);
  return !reduced && inView;
}
