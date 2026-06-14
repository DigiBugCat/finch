"use client";

import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav className={scrolled ? 'nav scrolled' : 'nav'} id="nav">
      <div className="wrap nav-in">
        <a className="logo" href="#top"><span className="logo-mark">🐦</span> Finch</a>
        <div className="nav-links">
          <a href="#how">How it works</a>
          <a href="#abilities">Abilities</a>
          <a href="#safety">Safety</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
        </div>
        <div className="nav-cta">
          <Link className="nav-signin" href="/sign-in">Sign in</Link>
          <Link className="btn btn-md btn-amber" href="/sign-up">Start free</Link>
        </div>
      </div>
    </nav>
  );
}
