import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Metadata } from 'next';
import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

// The sidebar highlights the current page; any path will do here.
vi.mock('next/navigation', () => ({ usePathname: () => '/docs' }));

import Code, { codeNodes } from '@/app/docs/code';
import DocsSidebar from '@/app/docs/sidebar';
import { metadata as docsLayoutMeta } from '@/app/docs/layout';
import * as Quickstart from '@/app/docs/page';
import * as Services from '@/app/docs/services/page';
import * as Auth from '@/app/docs/auth/page';
import * as Acls from '@/app/docs/acls/page';
import * as Domains from '@/app/docs/domains/page';
import * as Cli from '@/app/docs/cli/page';
import * as Privacy from '@/app/docs/privacy/page';
import * as AviaryMCP from '@/app/docs/aviarymcp/page';

type PageModule = { default: ComponentType; metadata?: Metadata };
const PAGES: Record<string, PageModule> = {
  '/docs': Quickstart,
  '/docs/services': Services,
  '/docs/auth': Auth,
  '/docs/acls': Acls,
  '/docs/domains': Domains,
  '/docs/cli': Cli,
  '/docs/privacy': Privacy,
  '/docs/aviarymcp': AviaryMCP,
};

const docsDir = resolve(import.meta.dirname, '../app/docs');

/** Every docs page this test knows about, straight from the file system. */
function docsPageFiles(): string[] {
  const dirs = readdirSync(docsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(resolve(docsDir, d.name, 'page.tsx')));
  return ['page.tsx', ...dirs.map((d) => `${d.name}/page.tsx`)];
}

// Pages another track owns in this release (the self-host guide). They get
// their own tests; listing them here keeps the coverage check below honest.
const OWNED_ELSEWHERE = ['self-host/page.tsx'];

/** A page's visible prose: its text with the code blocks taken out (and, with
 *  dropInline, the inline code too, e.g. the literal finch.yml key `box`). */
function prose(page: PageModule, dropInline = false): string {
  const Page = page.default;
  const { container, unmount } = render(<Page />);
  // Work on a copy: React still owns the rendered nodes.
  const copy = container.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(dropInline ? 'pre, code' : 'pre').forEach((p) => p.remove());
  const text = copy.textContent ?? '';
  unmount();
  return text;
}

describe('the docs code block', () => {
  it('shows placeholders like <slug> and <name> as written instead of swallowing them as tags', () => {
    const { container } = render(<Code>{'https://<slug>.finchmcp.com/<name>/\n<span class="c"># an MCP server answers at /<name>/mcp</span>'}</Code>);
    const code = container.querySelector('pre.docs-code > code')!;
    expect(code.textContent).toBe('https://<slug>.finchmcp.com/<name>/\n# an MCP server answers at /<name>/mcp');
    // The comment is the only element: <slug> and <name> did not become tags.
    expect([...code.children].map((c) => `${c.tagName}.${c.className}`)).toEqual(['SPAN.c']);
  });

  it('never turns other markup into elements, however it is written', () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script><span class="x">no</span><span class="o" onclick="y">o?</span>';
    const { container } = render(<Code>{hostile}</Code>);
    const code = container.querySelector('code')!;
    expect(code.querySelector('img, script')).toBeNull();
    // Only the exact highlight spans are markup; everything else is text.
    expect(code.children).toHaveLength(0);
    expect(code.textContent).toBe(hostile);
  });

  it('keeps output and comment spans, and decodes the few entities older snippets use', () => {
    const nodes = render(<>{codeNodes('a &lt;b&gt; &amp; c\n<span class="o">done &#39;ok&#39;</span>')}</>).container;
    expect(nodes.textContent).toBe("a <b> & c\ndone 'ok'");
    expect(nodes.querySelector('span.o')!.textContent).toBe("done 'ok'");
  });

  it('is the only code block the docs use: no page renders raw HTML', () => {
    for (const file of docsPageFiles().filter((f) => !OWNED_ELSEWHERE.includes(f))) {
      const src = readFileSync(resolve(docsDir, file), 'utf8');
      expect({ file, raw: /dangerouslySetInnerHTML/.test(src) }).toEqual({ file, raw: false });
      expect({ file, ownCode: /function Code\(/.test(src) }).toEqual({ file, ownCode: false });
    }
  });

  it('renders the /docs/domains URL templates with every placeholder visible', () => {
    const Page = Domains.default;
    const { container } = render(<Page />);
    const text = [...container.querySelectorAll('pre')].map((p) => p.textContent).join('\n');
    expect(text).toContain('https://<slug>.finchmcp.com/<name>/');
    expect(text).toContain('# an MCP server answers at /<name>/mcp');
    expect(text).toContain('https://<machine>.yourdomain.com/<name>/');
    expect(text).not.toMatch(/https:\/\/\.finchmcp\.com\/\//);
  });
});

describe('docs page titles', () => {
  it('gives every docs page its own title under the "· finch docs" template', () => {
    expect(docsLayoutMeta.title).toEqual({ default: 'finch docs', template: '%s · finch docs' });
    // Every page file on disk is covered here (a new page needs a title too).
    const known = Object.keys(PAGES).map((p) => (p === '/docs' ? 'page.tsx' : `${p.slice('/docs/'.length)}/page.tsx`));
    for (const file of docsPageFiles()) {
      expect({ file, covered: known.includes(file) || OWNED_ELSEWHERE.includes(file) }).toEqual({ file, covered: true });
    }
    const titles = Object.entries(PAGES).map(([path, page]) => {
      const title = page.metadata?.title;
      expect({ path, type: typeof title }).toEqual({ path, type: 'string' });
      expect(title as string).not.toMatch(/finch|\|/i); // the template adds the brand
      expect(typeof page.metadata?.description).toBe('string');
      // A shared link previews as this page, not as the landing.
      expect(page.metadata?.openGraph).toMatchObject({ title: `${title} · finch docs`, description: page.metadata?.description });
      expect(page.metadata?.twitter).toMatchObject({ title: `${title} · finch docs` });
      // Overriding openGraph drops the file-based share image, so it must be
      // named again, and it must be a file that exists.
      expect(page.metadata?.openGraph).toMatchObject({ images: [{ url: '/opengraph-image.png', width: 1200, height: 630 }] });
      expect(existsSync(resolve(docsDir, '..', 'opengraph-image.png'))).toBe(true);
      return title;
    });
    expect(new Set(titles).size).toBe(titles.length);
    expect(PAGES['/docs/auth'].metadata?.title).toBe('Keys & auth');
    expect(PAGES['/docs/aviarymcp'].metadata?.title).toBe('AviaryMCP');
  });
});

describe('docs wording', () => {
  it('uses one word per idea: machine (not box), lowercase finch, no tenant or app_path in prose', () => {
    for (const [path, page] of Object.entries(PAGES)) {
      const text = prose(page, true);
      for (const [label, re] of [
        ['box', /\bbox(es)?\b/i],
        ['capital Finch', /\bFinch\b/],
        ['tenant', /tenant/i],
        ['app_path', /app_path/],
        ['your-slug placeholder', /your-slug/],
        ['maray', /maray/i],
        ['for life', /for life/i],
        ['dashboard', /dashboard/i],
      ] as const) {
        expect({ path, label, found: re.test(text) }).toEqual({ path, label, found: false });
      }
    }
  });

  it('explains the account address once, with a real-looking example, on the quickstart', () => {
    const text = prose(Quickstart);
    expect(text).toMatch(/sunny-wren-42, is your account address \(also\s+called the slug\)/);
  });

  it('marks custom domains as not live instead of promising three steps', () => {
    const Page = Domains.default;
    render(<Page />);
    const heading = screen.getByRole('heading', { level: 2, name: /Custom domains/ });
    expect(heading).toHaveTextContent('Not live yet');
    expect(screen.getByText(/Custom domains don.t serve traffic yet\./)).toBeInTheDocument();
    expect(screen.queryByText(/certificate is issued automatically/)).toBeNull();
    expect(screen.queryByText(/go live on the new name/)).toBeNull();
  });

  it('keeps the onboarding on finch: AviaryMCP is a related page, not a first step', () => {
    render(<DocsSidebar />);
    const nav = screen.getByRole('navigation', { name: 'Docs' });
    const getStarted = within(nav).getByRole('list', { name: 'Get started' });
    expect(within(getStarted).queryByRole('link', { name: /AviaryMCP/ })).toBeNull();
    expect(within(getStarted).getByRole('link', { name: 'Services & machines' })).toHaveAttribute('href', '/docs/services');
    const related = within(nav).getByRole('list', { name: 'Related' });
    expect(within(related).getByRole('link', { name: /AviaryMCP/ })).toHaveAttribute('href', '/docs/aviarymcp');
    // And the quickstart doesn't open with it either.
    expect(prose(Quickstart).slice(0, 600)).not.toMatch(/AviaryMCP/);
  });

  it('drops the retired login-ticket pointer and the old foreground-run quickstart', () => {
    const text = prose(Quickstart);
    expect(text).not.toMatch(/tickets and\s+token-piped logins/);
    expect(text).not.toMatch(/next to your project/);
    expect(text).toMatch(/~\/\.finch\/finch\.yml/);
  });
});

describe('docs describe the CLI shipping in this release', () => {
  const all = () => Object.values(PAGES).map((p) => {
    const Page = p.default;
    const { container, unmount } = render(<Page />);
    const t = container.textContent ?? '';
    unmount();
    return t;
  }).join('\n');

  it('teaches humans plain `finch login`, and leaves --start/--poll to scripts and agents', () => {
    const Page = Quickstart.default;
    const { container } = render(<Page />);
    const blocks = [...container.querySelectorAll('pre')].map((p) => p.textContent!);
    const loginStep = blocks.find((b) => b.startsWith('finch login'))!;
    expect(loginStep.split('\n')[0]).toBe('finch login');
    expect(container.textContent).not.toMatch(/--start|--poll/);
    expect(container.textContent).toMatch(/finch login --headless/);
    expect(prose(Cli)).toMatch(/Plain finch login waits for you/);
  });

  it('walks login → add → service install → test → connect, with keys as the fallback', () => {
    const Page = Quickstart.default;
    render(<Page />);
    const steps = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(steps.slice(0, 7)).toEqual([
      '1. Write an MCP server', '2. Install finch', '3. Log in', '4. Add the service',
      '5. Keep it running', '6. Test it', '7. Connect a client',
    ]);
    const text = document.body.textContent!;
    expect(text).toMatch(/finch service install/);
    expect(text).toMatch(/finch connect hello --client claude-code/);
    expect(text).toMatch(/finch keys mint my-client --service hello/);
  });

  it('documents every new command and flag', () => {
    const text = all();
    for (const needle of [
      'finch uninstall',
      'finch logs',
      '--limit N',
      '--forward-all',
      'forward_all: true',
      'finch 1.8.0 is already the latest',
      'finch help <command>',
      'logged_in',
      'finch rm',
      "the server rejected the MCP handshake",
      "finch reached the machine, but the local service isn't answering",
    ]) {
      expect({ needle, found: text.includes(needle) }).toEqual({ needle, found: true });
    }
  });

  it('says what finch rm and finch uninstall clean up, and that uninstall keeps the binary', () => {
    const cli = prose(Cli);
    expect(cli).toMatch(/Remove a service: from your account, from this machine.s finch\.yml, and its credential/);
    expect(cli).toMatch(/revokes the keys this machine made with finch connect/);
    expect(cli).toMatch(/never deletes the finch binary itself; it prints the command/);
  });

  it('marks the AviaryMCP REST and OpenAPI paths as needing --forward-all', () => {
    const Page = AviaryMCP.default;
    const { container } = render(<Page />);
    const blocks = [...container.querySelectorAll('pre')].map((p) => p.textContent!).join('\n');
    expect(blocks).toContain('finch add calculator --service http://127.0.0.1:8000 --forward-all');
    expect(container.textContent).toMatch(/Without --forward-all, only the MCP row works/);
    expect(blocks).not.toMatch(/^finch run$/m);
  });

  it('shows real CLI output in the transcripts, not a nicer invented line', () => {
    const text = all();
    expect(text).not.toMatch(/✓ https:\/\//);
    expect(text).toContain('finch: added "hello" → http://127.0.0.1:8000');
    expect(text).toContain('public URL: https://sunny-wren-42.finchmcp.com/hello/mcp');
  });
});
