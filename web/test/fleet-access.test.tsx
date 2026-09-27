// How people reach /fleet: the middleware gates it behind sign-in (Clerk's
// auth.protect sends a signed-out visit to sign-in and back), the signed-in
// nav links to it, and a sign-in or sign-up with nowhere else to go lands there.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { NextRequest } from 'next/server';
import { parseJsonc } from '@/scripts/jsonc.mjs';

// ---- middleware: run the real handler against a route matcher built from the
//      patterns middleware.ts declares (Clerk's matcher semantics: a pattern
//      matches the whole pathname).
const matcherPatterns: string[][] = [];
let handler: (auth: unknown, req: NextRequest) => Promise<unknown>;
vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (h: typeof handler) => {
    handler = h;
    return h;
  },
  createRouteMatcher: (patterns: string[]) => {
    matcherPatterns.push(patterns);
    const res = patterns.map((p) => new RegExp(`^${p}$`));
    return (req: Request) => res.some((re) => re.test(new URL(req.url).pathname));
  },
}));

const clerk = vi.hoisted(() => ({ auth: { isLoaded: true, isSignedIn: false } }));
vi.mock('@clerk/nextjs', () => ({
  useAuth: () => clerk.auth,
  UserButton: () => <button type="button">Open account menu</button>,
}));

import SiteNav from '@/components/fieldguide/SiteNav';

async function protects(path: string): Promise<boolean> {
  vi.resetModules();
  matcherPatterns.length = 0;
  await import('@/middleware');
  const protect = vi.fn();
  await handler({ protect }, new Request(`https://finchmcp.com${path}`) as unknown as NextRequest);
  return protect.mock.calls.length > 0;
}

describe('who can open /fleet', () => {
  it('requires sign-in for /fleet (and still for /cli), not for the public pages', async () => {
    expect(await protects('/fleet')).toBe(true);
    expect(await protects('/cli')).toBe(true);
    for (const path of ['/', '/docs', '/docs/cli', '/sign-in', '/sign-up', '/agents.md']) {
      expect(await protects(path), path).toBe(false);
    }
  });
});

describe('the signed-in nav', () => {
  beforeEach(() => {
    clerk.auth = { isLoaded: true, isSignedIn: false };
  });

  it('shows Your fleet next to the account button once signed in', () => {
    clerk.auth = { isLoaded: true, isSignedIn: true };
    render(<SiteNav />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const fleet = within(nav).getByRole('link', { name: 'Your fleet' });
    expect(fleet).toHaveAttribute('href', '/fleet');
    expect(fleet).not.toHaveAttribute('aria-current');
    const account = within(nav).getByRole('button', { name: 'Open account menu' });
    // Side by side: the fleet link comes right before the account button.
    expect(fleet.nextElementSibling).toContainElement(account);
  });

  it('keeps Your fleet out of a signed-out (or still loading) nav', () => {
    render(<SiteNav />);
    expect(screen.queryByRole('link', { name: 'Your fleet' })).toBeNull();
    clerk.auth = { isLoaded: false, isSignedIn: true };
    render(<SiteNav />);
    expect(screen.queryByRole('link', { name: 'Your fleet' })).toBeNull();
  });
});

describe('where sign-in and sign-up land', () => {
  const wrangler = parseJsonc(readFileSync(resolve(import.meta.dirname, '../wrangler.jsonc'), 'utf8'));

  it('sends a fresh sign-in or sign-up to /fleet in every deployed env', () => {
    for (const env of ['staging', 'production']) {
      const vars = wrangler.env[env].vars;
      expect(vars.NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL, env).toBe('/fleet');
      expect(vars.NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL, env).toBe('/fleet');
    }
  });
});
