import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { parseJsonc } from '@/scripts/jsonc.mjs';
import { checkDurableObjectMigrations } from '../../worker/scripts/do-migrations.mjs';

vi.mock('next/navigation', () => ({ usePathname: () => '/docs/self-host' }));

const { default: SelfHost } = await import('@/app/docs/self-host/page');
const { default: DocsSidebar } = await import('@/app/docs/sidebar');

const repo = resolve(import.meta.dirname, '../..');
const read = (p: string) => readFileSync(resolve(repo, p), 'utf8');
const guide = read('docs/self-host.md');
const hubEnv = read('worker/src/index.ts');

/** The `"selfhost": { … }` wrangler blocks the guide tells people to paste. */
function guideBlocks(): { hub: Record<string, any>; web: Record<string, any> } {
  const blocks = [...guide.matchAll(/```jsonc\n([\s\S]*?)```/g)].map((m) => parseJsonc(`{${m[1]}}`).selfhost);
  expect(blocks).toHaveLength(2);
  return { hub: blocks[0], web: blocks[1] };
}

describe('/docs/self-host', () => {
  it('keeps placeholders in code and prose instead of stripping them as HTML', () => {
    const { container } = render(<SelfHost />);
    expect(screen.getByRole('heading', { level: 1, name: 'Run your own finch' })).toBeInTheDocument();
    expect(container).toHaveTextContent('https://finch.example.dev/<service>/mcp');
    expect(container).toHaveTextContent('<WEB_URL>/cli');
    const code = [...container.querySelectorAll('pre code')].map((el) => el.textContent ?? '');
    expect(code.some((c) => c.includes('finch login --hub https://finch.example.dev'))).toBe(true);
    expect(code.some((c) => c.includes('npx wrangler deploy --env selfhost'))).toBe(true);
  });

  it('states the single-account limit and links the full guide and checklist', () => {
    render(<SelfHost />);
    expect(screen.getByText(/A self-hosted hub serves one account/)).toBeInTheDocument();
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://github.com/DigiBugCat/finch/blob/main/docs/self-host-coupling.md');
    expect(hrefs).toContain('https://github.com/DigiBugCat/finch/blob/main/docs/self-host.md');
    expect(screen.getAllByText('openid email profile').length).toBeGreaterThan(0);
  });

  it('makes restricting sign-ups mandatory and names the hub hostname reservation', () => {
    const { container } = render(<SelfHost />);
    expect(container).toHaveTextContent(/This step is required/);
    expect(container).toHaveTextContent(/finch domain add/);
    const named = [...container.querySelectorAll('td:first-child code')].map((el) => el.textContent);
    expect(named).toContain('VANITY_SUFFIXES');
    expect(named).toContain('VANITY_TENANT');
  });

  it('tells readers finch update needs --hub without a saved login', () => {
    const { container } = render(<SelfHost />);
    expect(container).toHaveTextContent(/finch update and finch enroll ignore FINCH_HUB/);
  });

  it('is linked from the docs sidebar and marked as the current page', () => {
    render(<DocsSidebar />);
    const link = screen.getByRole('link', { name: 'Run your own finch' });
    expect(link).toHaveAttribute('href', '/docs/self-host');
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('names only hub settings the hub actually reads', () => {
    const { container } = render(<SelfHost />);
    const named = new Set(
      [...container.querySelectorAll('td:first-child code')]
        .map((el) => el.textContent ?? '')
        .filter((t) => /^[A-Z][A-Z0-9_]+$/.test(t)),
    );
    expect(named.size).toBeGreaterThan(5);
    for (const name of named) expect(hubEnv).toMatch(new RegExp(`^\\s+${name}\\??:`, 'm'));
  });
});

describe('docs/self-host.md configuration blocks', () => {
  it('give the hub every binding it declares and the full migration history', () => {
    const { hub } = guideBlocks();
    expect(checkDurableObjectMigrations('selfhost', hub)).toEqual([]);
    const bindings = [
      ...hub.durable_objects.bindings.map((b: { name: string }) => b.name),
      ...hub.services.map((b: { binding: string }) => b.binding),
      ...hub.unsafe.bindings.map((b: { name: string }) => b.name),
    ];
    for (const name of ['BOX', 'TENANT', 'ROUTER', 'SELF', 'RELAY_LIMIT', 'JOIN_LIMIT']) {
      expect(bindings).toContain(name);
    }
    for (const name of Object.keys(hub.vars)) expect(hubEnv).toMatch(new RegExp(`^\\s+${name}\\??:`, 'm'));
    expect(hub.vars.ALLOW_INSECURE_HTTP).toBeUndefined();
    expect(hub.services[0].service).toBe(hub.name);
    expect(hub.logpush).toBe(false);
    expect(hub.observability.enabled).toBe(false);
  });

  it('reserve the hub hostname for the owner so no other account can claim it', () => {
    const { hub } = guideBlocks();
    const suffixes = String(hub.vars.VANITY_SUFFIXES ?? '')
      .split(',')
      .map((s: string) => s.trim().toLowerCase())
      .filter(Boolean);
    const hosts = hub.routes.map((r: { pattern: string }) => r.pattern.split('/')[0].toLowerCase());
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) {
      expect(suffixes.some((s: string) => host === s || host.endsWith(`.${s}`))).toBe(true);
    }
    expect(hub.vars.VANITY_TENANT).toBe(hub.vars.DEFAULT_TENANT);
    // Required, not optional: the guide must not tell readers to skip it.
    expect(guide).toMatch(/This is required, not a nicety/);
  });

  it('bind the website to the hub it deploys and pin an exact https origin', () => {
    const { hub, web } = guideBlocks();
    const services = Object.fromEntries(
      web.services.map((s: { binding: string; service: string }) => [s.binding, s.service]),
    );
    expect(services.FINCH_HUB).toBe(hub.name);
    expect(services.WORKER_SELF_REFERENCE).toBe(web.name);
    const origin = new URL(web.vars.NEXT_PUBLIC_APP_ORIGIN);
    expect(origin.protocol).toBe('https:');
    expect(origin.origin).toBe(web.vars.NEXT_PUBLIC_APP_ORIGIN);
    expect(web.vars.HUB_URL).toBe(hub.vars.FINCH_ASSERTION_ISSUER);
    expect(web.logpush).toBe(false);
    expect(web.observability.logs.invocation_logs).toBe(false);
    expect(web.observability.traces.enabled).toBe(false);
  });
});
