import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

// The 404 carries the site nav, whose account slot reads Clerk.
vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: false }),
  UserButton: () => null,
}));

import sitemap from '@/app/sitemap';
import robots from '@/app/robots';
import NotFound, { metadata as notFoundMeta } from '@/app/not-found';
import { SITE, SITEMAP_PATHS } from '@/app/site-paths';

const appDir = resolve(import.meta.dirname, '../app');

describe('sitemap.xml', () => {
  it('lists every docs page, as absolute finchmcp.com URLs', () => {
    const entries = sitemap();
    const urls = entries.map((e) => e.url);
    for (const u of urls) expect(u.startsWith('https://finchmcp.com')).toBe(true);
    expect(urls[0]).toBe('https://finchmcp.com');
    expect(new Set(urls).size).toBe(urls.length);
    // Every docs page on disk is in it, so a new page can't be forgotten.
    const docsDirs = readdirSync(resolve(appDir, 'docs'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(resolve(appDir, 'docs', d.name, 'page.tsx')))
      .map((d) => `/docs/${d.name}`);
    expect(docsDirs.length).toBeGreaterThan(5);
    for (const path of ['/docs', ...docsDirs]) {
      expect({ path, listed: (SITEMAP_PATHS as readonly string[]).includes(path) }).toEqual({ path, listed: true });
    }
    // ...and every docs path it lists is a page on disk, so it never sends a
    // crawler (or the landing's links) to a 404.
    for (const path of SITEMAP_PATHS.filter((p) => p.startsWith('/docs/'))) {
      const page = resolve(appDir, `.${path}`, 'page.tsx');
      expect({ path, exists: existsSync(page) }).toEqual({ path, exists: true });
    }
    // The pages agents are told to read are listed too.
    expect(urls).toEqual(expect.arrayContaining([`${SITE}/agents.md`, `${SITE}/llms.txt`]));
  });

  it('leaves out the pages that only make sense signed in', () => {
    for (const path of SITEMAP_PATHS) expect(path).not.toMatch(/^\/(cli|sign-in|sign-up|api|dashboard)\b/);
  });
});

describe('robots.txt', () => {
  it('lets crawlers read the site but not the sign-in, approval and API routes, and names the sitemap', () => {
    const r = robots();
    expect(r.sitemap).toBe('https://finchmcp.com/sitemap.xml');
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ userAgent: '*', allow: '/' });
    expect(rules[0].disallow).toEqual(expect.arrayContaining(['/cli', '/sign-in', '/sign-up', '/api/']));
  });
});

describe('the 404 page', () => {
  it('is a field-guide page with the nav and the likely next stops', () => {
    render(<NotFound />);
    expect(screen.getByRole('heading', { level: 1, name: 'This page has flown off.' })).toBeInTheDocument();
    expect(screen.getByText('404 · Not in this guide')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs');
    expect(screen.getByRole('link', { name: 'The quickstart' })).toHaveAttribute('href', '/docs');
    const agentLinks = screen.getAllByRole('link', { name: 'agents.md' }).map((a) => a.getAttribute('href'));
    expect(agentLinks).toContain('/agents.md');
    expect(screen.getByText('curl -fsSL https://finchmcp.com/install | sh')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('has a title of its own (the root template makes it "Page not found · finch")', () => {
    expect(notFoundMeta.title).toBe('Page not found');
    // Next adds <meta name="robots" content="noindex"> to every 404 itself; a
    // second one from here would only duplicate it.
    expect(notFoundMeta.robots).toBeUndefined();
  });
});
