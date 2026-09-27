import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

// Clerk is the nav's only outside input: a session that tests can flip between
// loading, signed out and signed in. UserButton stands in as a labelled button.
const clerk = vi.hoisted(() => ({ auth: { isLoaded: true, isSignedIn: false } }));
vi.mock('@clerk/nextjs', () => ({
  useAuth: () => clerk.auth,
  UserButton: () => <button type="button">Open account menu</button>,
}));

import Home from '@/app/page';
import SiteNav from '@/components/fieldguide/SiteNav';
import AgentSession, { SESSION } from '@/components/fieldguide/AgentSession';
import { logRows } from '@/components/fieldguide/SightingLog';
import { breakableParts } from '@/components/fieldguide/GateDial';

// The one paste for humans, verbatim from the shared CLI contract. Pinned here
// as a literal (not imported) so a drift in the component fails this test.
const CONTRACT_PROMPT =
  'Read https://finchmcp.com/agents.md and use finch to publish my MCP server on http://127.0.0.1:8000 as notes. Show me the sign-in link when you get it. Run it as a background service, check it with finch test, then connect it to this agent.';

// Every finch command the landing may show, per the shared CLI contract (plus
// the existing `keys mint`). Anything else is a drifted command.
const NAME = '[a-z][a-z0-9-]*';
const URL = 'https?://[^\\s]+';
const FINCH_COMMANDS = [
  new RegExp(`^finch login$`),
  new RegExp(`^finch login --start( --json)?( --hub ${URL})?$`),
  new RegExp(`^finch login --poll( --json)?$`),
  new RegExp(`^finch add ${NAME} --service ${URL}( --public)?( --json)?$`),
  new RegExp(`^finch service (install|uninstall|status)( --json)?$`),
  new RegExp(`^finch test ${NAME}( --json)?$`),
  new RegExp(`^finch connect ${NAME} --client (claude-code|cursor|codex|json)( --json)?$`),
  new RegExp(`^finch keys mint ${NAME} --service ${NAME}$`),
];

function assertContractCommand(cmd: string) {
  if (!FINCH_COMMANDS.some((re) => re.test(cmd))) {
    throw new Error(`not a contract command: ${JSON.stringify(cmd)}`);
  }
}

describe('the contract-command checker itself', () => {
  it('rejects commands outside the contract', () => {
    expect(() => assertContractCommand('finch login --wait')).toThrow();
    expect(() => assertContractCommand('finch connect notes --client vscode')).toThrow();
    expect(() => assertContractCommand('finch add notes http://127.0.0.1:8000')).toThrow();
    expect(() => assertContractCommand('finch service start')).toThrow();
    expect(() => assertContractCommand('finch add demo --service http://127.0.0.1:3000 --public')).not.toThrow();
  });
});

describe('field-guide landing', () => {
  it('renders the hero and every plate the nav points at', () => {
    const { container } = render(<Home />);

    expect(screen.getByRole('heading', { level: 1, name: 'Localhost, with a front door.' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const hash of ['band', 'gate', 'agents', 'pricing']) {
      expect(nav.querySelector(`a[href="/#${hash}"]`)).not.toBeNull();
      expect(container.querySelector(`#${hash}`)).not.toBeNull();
    }
    expect(within(nav).getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs');
    expect(within(nav).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
    // Seven plates, numbered in order.
    const plates = ['Plate I', 'Plate II · The band', 'Plate III · A field recording', 'Plate IV · The gate',
      'Plate V · For agents', 'Plate VI · The sighting log', 'Plate VII · Pricing'];
    for (const p of plates) expect(screen.getByText(p)).toBeInTheDocument();
  });

  it('shows the agent prompt verbatim and the manual steps as contract commands', () => {
    render(<Home />);

    expect(screen.getByTestId('agent-prompt').textContent).toBe(CONTRACT_PROMPT);
    const manual = screen.getByText(/^curl -fsSL https:\/\/finchmcp\.com\/install \| sh/);
    const lines = manual.textContent!.split('\n');
    expect(lines[0]).toBe('curl -fsSL https://finchmcp.com/install | sh');
    expect(lines.slice(1)).toEqual([
      'finch login',
      'finch add notes --service http://127.0.0.1:8000',
      'finch service install',
    ]);
    lines.slice(1).forEach(assertContractCommand);
  });

  it('types only contract commands and contract-shaped JSON in the agent session', () => {
    for (const line of SESSION.filter((l) => l.kind === 'cmd')) {
      const cmd = line.text.replace(/^\$ /, '');
      if (cmd.startsWith('curl ')) {
        expect(cmd).toBe('curl -fsSL https://finchmcp.com/install | sh');
        continue;
      }
      assertContractCommand(cmd);
    }
    const cmds = SESSION.filter((l) => l.kind === 'cmd').map((l) => l.text);
    // The agent walks the whole contract: start, poll, add, service, test, connect.
    expect(cmds).toEqual(expect.arrayContaining([
      '$ finch login --start --json',
      '$ finch login --poll --json',
      '$ finch service install',
      '$ finch test notes',
      '$ finch connect notes --client claude-code',
    ]));

    // JSON output carries schema_version 1; the poll result parses in full.
    const json = SESSION.filter((l) => l.kind === 'out' && l.text.startsWith('{'));
    expect(json.length).toBe(2);
    for (const l of json) expect(l.text).toMatch(/^\{"schema_version":1,/);
    const poll = JSON.parse(json[1].text);
    expect(poll).toEqual({ schema_version: 1, status: 'approved', account: 'maray' });
  });

  it('turns the gate dial with real toggle buttons', () => {
    const { container } = render(<Home />);
    const group = screen.getByRole('group', { name: 'Who gets in' });
    const key = within(group).getByRole('button', { name: 'Key' });
    const oauth = within(group).getByRole('button', { name: 'Sign in' });
    const pub = within(group).getByRole('button', { name: 'Public' });
    const gateCode = () => container.querySelector('#gate .fg-gate-detail code')!.textContent;

    expect(key).toHaveAttribute('aria-pressed', 'true');
    expect(oauth).toHaveAttribute('aria-pressed', 'false');
    expect(gateCode()).toBe('finch keys mint cursor --service notes');
    assertContractCommand(gateCode()!);

    fireEvent.click(pub);
    expect(pub).toHaveAttribute('aria-pressed', 'true');
    expect(key).toHaveAttribute('aria-pressed', 'false');
    expect(gateCode()).toBe('finch add demo --service http://127.0.0.1:3000 --public');
    assertContractCommand(gateCode()!);
    expect(screen.getByRole('img', { name: 'Garden gate: anyone can walk in' })).toBeInTheDocument();

    fireEvent.click(oauth);
    expect(oauth).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Sign in at the gate' })).toBeInTheDocument();
  });

  it('announces a dial change from a live region that stays mounted', () => {
    const { container } = render(<Home />);
    const live = container.querySelector('#gate [aria-live="polite"]')!;
    expect(live).not.toBeNull();
    // Exactly one live region in the plate, holding the detail.
    expect(container.querySelectorAll('#gate [aria-live]')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Public' }));
    // The same node, now carrying the new detail: a region inserted together
    // with its content is not announced, so it must not be remounted.
    expect(container.querySelector('#gate [aria-live="polite"]')).toBe(live);
    expect(live).toHaveTextContent('Leave the gate open');
    expect(live).toHaveTextContent('finch add demo --service http://127.0.0.1:3000 --public');
  });

  it('lets a gate command wrap only between words or URL path segments, never inside a flag', () => {
    const { container } = render(<Home />);
    const seen: string[][] = [];
    for (const name of ['Key', 'Sign in', 'Public']) {
      fireEvent.click(screen.getByRole('button', { name }));
      const code = container.querySelector('#gate .fg-gate-detail code')!;
      // All visible text sits in unbreakable spans; the only other children
      // are <wbr> break points (and the spaces between words).
      for (const c of code.children) {
        if (c.tagName === 'WBR') continue;
        expect(c.tagName).toBe('SPAN');
        expect(c).toHaveClass('fg-nowrap');
      }
      const pieces = [...code.querySelectorAll('.fg-nowrap')].map((s) => s.textContent!);
      for (const flag of code.textContent!.match(/--[a-z-]+/g) ?? []) {
        expect(pieces.some((p) => p.includes(flag))).toBe(true);
      }
      seen.push(pieces);
    }
    expect(seen).toEqual([
      ['finch', 'keys', 'mint', 'cursor', '--service', 'notes'],
      ['https://maray.finchmcp.com/', 'notes/', 'mcp'],
      ['finch', 'add', 'demo', '--service', 'http://127.0.0.1:3000', '--public'],
    ]);
    expect(container.querySelector('#gate code')!.textContent).toBe('finch add demo --service http://127.0.0.1:3000 --public');
  });

  it('splits only URLs at path slashes, and loses no characters doing it', () => {
    expect(breakableParts('--service')).toEqual(['--service']);
    expect(breakableParts('http://127.0.0.1:3000')).toEqual(['http://127.0.0.1:3000']);
    expect(breakableParts('https://a.finchmcp.com/notes/mcp')).toEqual(['https://a.finchmcp.com/', 'notes/', 'mcp']);
    for (const t of ['https://a.b/', 'https://a.b//x//y/', 'http://h:1/p?q=a/b']) {
      expect(breakableParts(t).join('')).toBe(t);
    }
  });

  it('names every panorama label in the legend line phones see instead', () => {
    const { container } = render(<Home />);
    // landing.css hides .fg-hero-label below 760px (it renders at ~3.5px
    // there) and shows .fg-hero-places, so that line must carry every label.
    const labels = [...container.querySelectorAll('.fg-hero-svg .fg-hero-label text')].map((t) => t.textContent!);
    expect(labels).toEqual(['finchmcp.com', 'Claude', 'Cursor', 'ChatGPT']);
    const places = container.querySelector('.fg-hero-places')!.textContent!;
    for (const l of labels) expect(places).toContain(l);
    expect(places).toContain('your machine');
  });

  it('shows the band address exactly as typed, never case-transformed', () => {
    // The service path is case-sensitive (/NOTES/mcp is not /notes/mcp), so
    // the ring must not uppercase it: nothing styling the address may transform case.
    const css = readFileSync(resolve(import.meta.dirname, '../components/fieldguide/landing.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]*\.fg-(?:band|seg)[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector, body] of rules) {
      expect({ selector: selector.trim(), transform: /text-transform/.test(body) }).toEqual({ selector: selector.trim(), transform: false });
    }
    render(<Home />);
    const addr = screen.getByText('maray.finchmcp.com/notes/mcp', { selector: '.fg-band > span' });
    expect(addr.textContent).toBe(addr.textContent!.toLowerCase());
  });

  it('labels the band address and its anatomy for screen readers', () => {
    render(<Home />);
    expect(screen.getByText('maray.finchmcp.com/notes/mcp', { selector: '.fg-band > span' })).toBeInTheDocument();
    const terms = screen.getAllByRole('term').map((t) => t.textContent);
    expect(terms).toEqual(['maray', '.finchmcp.com', '/notes', '/mcp']);
    const defs = screen.getAllByRole('definition').map((d) => d.textContent);
    expect(defs).toEqual(['your account', 'the relay', 'the name you chose', 'where clients connect']);
  });

  it('prices it Free and Enterprise with working calls to action', () => {
    render(<Home />);
    expect(screen.getByRole('link', { name: 'Create a free account' })).toHaveAttribute('href', '/sign-up');
    expect(screen.getByRole('link', { name: 'Email us' })).toHaveAttribute('href', 'mailto:hello@aviary.run');
  });
});

describe('copy the agent prompt', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  });

  function mockClipboard(writeText: (text: unknown) => Promise<void>) {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  }

  it('copies exactly the contract prompt and says so', async () => {
    const copied: string[] = [];
    mockClipboard(async (text) => {
      if (typeof text !== 'string' || text !== CONTRACT_PROMPT) throw new Error(`unexpected payload ${String(text)}`);
      copied.push(text);
    });
    render(<Home />);

    const [heroButton] = screen.getAllByRole('button', { name: 'Copy the agent prompt' });
    await act(async () => { fireEvent.click(heroButton); });
    expect(copied).toEqual([CONTRACT_PROMPT]);
    expect(heroButton).toHaveTextContent('Copied. Paste it into your agent');
  });

  it('does not claim success when the clipboard refuses', async () => {
    mockClipboard(async () => { throw new DOMException('denied', 'NotAllowedError'); });
    render(<Home />);

    const [heroButton] = screen.getAllByRole('button', { name: 'Copy the agent prompt' });
    await act(async () => { fireEvent.click(heroButton); });
    expect(heroButton).toHaveTextContent(/Could not copy/);
    expect(heroButton).not.toHaveTextContent(/Copied/);
  });
});

describe('agent session motion', () => {
  const QUERY = '(prefers-reduced-motion: reduce)';
  let reduced = false;
  const realMatchMedia = window.matchMedia;
  const realIO = window.IntersectionObserver;

  beforeEach(() => {
    vi.useFakeTimers();
    // Only the one query the page asks; any other query is a bug.
    window.matchMedia = ((q: string) => {
      if (q !== QUERY) throw new Error(`unexpected media query ${q}`);
      return { matches: reduced, media: q, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList;
    }) as typeof window.matchMedia;
    // An observer that reports the plate on screen as soon as it is observed.
    window.IntersectionObserver = class {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(el: Element) {
        if (!(el instanceof Element)) throw new TypeError('observe() needs an Element');
        this.cb([{ isIntersecting: true, target: el } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
      }
      disconnect() {}
      unobserve() {}
      takeRecords() { return []; }
    } as unknown as typeof IntersectionObserver;
  });
  afterEach(() => {
    vi.useRealTimers();
    window.matchMedia = realMatchMedia;
    window.IntersectionObserver = realIO;
  });

  const typed = (c: HTMLElement) =>
    c.querySelectorAll('.fg-term-lines > span:not(.fg-term-cursor):not(.fg-term-pending)').length;
  // The terminal's rows, in order: every session line plus exactly one cursor.
  // Untyped lines stay in the layout (hidden), so the box is always sized by
  // the whole transcript and the finished frame never clips its first line.
  const rows = (c: HTMLElement) =>
    [...c.querySelectorAll('.fg-term-lines > span')].map((s) =>
      s.classList.contains('fg-term-cursor') ? 'CURSOR' : s.classList.contains('fg-term-pending') ? `(${s.textContent})` : s.textContent,
    );

  it('holds the finished session, phone approved, for reduced motion', () => {
    reduced = true;
    const { container } = render(<AgentSession />);
    expect(typed(container)).toBe(SESSION.length);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(typed(container)).toBe(SESSION.length);
    expect(container.querySelector('.fg-phone')).toHaveClass('is-shown');
    expect(screen.getByText('Approved ✓')).toBeInTheDocument();
    // The still frame starts at the install step and ends on the cursor.
    expect(rows(container)).toEqual([...SESSION.map((l) => l.text), 'CURSOR']);
  });

  it('types the session out line by line when motion is allowed', () => {
    reduced = false;
    const { container } = render(<AgentSession />);
    expect(typed(container)).toBe(0);
    expect(rows(container)).toEqual(['CURSOR', ...SESSION.map((l) => `(${l.text})`)]);
    act(() => { vi.advanceTimersByTime(650 * 3); });
    expect(typed(container)).toBe(3);
    // Typed lines first, then the cursor, then the rest held in place, hidden.
    expect(rows(container)).toEqual([
      ...SESSION.slice(0, 3).map((l) => l.text),
      'CURSOR',
      ...SESSION.slice(3).map((l) => `(${l.text})`),
    ]);
    expect(container.querySelector('.fg-phone')).not.toHaveClass('is-shown');
    act(() => { vi.advanceTimersByTime(650 * 3); });
    expect(container.querySelector('.fg-phone')).toHaveClass('is-shown');
    expect(screen.getByText('Approve')).toBeInTheDocument();
  });
});

describe('site nav account control', () => {
  beforeEach(() => { clerk.auth = { isLoaded: true, isSignedIn: false }; });

  it('offers Sign in to a signed-out visitor', () => {
    render(<SiteNav />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
    expect(within(nav).queryByRole('button', { name: 'Open account menu' })).toBeNull();
  });

  it('gives a signed-in visitor the account menu instead of Sign in', () => {
    clerk.auth = { isLoaded: true, isSignedIn: true };
    render(<SiteNav />);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('button', { name: 'Open account menu' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Sign in' })).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs');
  });

  it('keeps the Sign in link while Clerk is still loading (the prerendered HTML)', () => {
    clerk.auth = { isLoaded: false, isSignedIn: undefined as unknown as boolean };
    render(<SiteNav />);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  });
});

describe('sighting log rows', () => {
  it('is deterministic, newest first, three seconds apart', () => {
    const rows = logRows(0);
    expect(rows).toHaveLength(7);
    expect(rows[0].time).toBe('14:04:05');
    expect(rows[1].time).toBe('14:04:02');
    expect(logRows(0)).toEqual(rows);
  });

  it('shows only what the relay records: no turned-away calls, and every row has its route', () => {
    // Rejected calls (no key, a bad key) return before recordCall, so no
    // window of the log may show one.
    for (let tick = 0; tick < 60; tick++) {
      for (const r of logRows(tick)) {
        expect(r.status).toBe('200');
        expect(r.caller).not.toMatch(/unknown|denied|rejected/);
        // RecentCall.route is the whole request path, under the service.
        expect(r.route.startsWith(`/${r.svc}/`)).toBe(true);
      }
    }
    // Not vacuous: one service logs more than one route.
    const scraperRoutes = new Set(Array.from({ length: 60 }, (_, t) => logRows(t)).flat()
      .filter((r) => r.svc === 'scraper').map((r) => r.route));
    expect(scraperRoutes.size).toBeGreaterThan(1);
  });

  it('shows every stored field as a column, the body struck out, and says what is not logged', () => {
    render(<Home />);
    const table = screen.getByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Time', 'Service', 'Route', 'Caller', 'Status', 'Took', 'Body']);
    const first = within(table).getAllByRole('row')[1];
    const cells = within(first).getAllByRole('cell').map((c) => c.textContent);
    const [row] = logRows(0);
    expect(cells).toEqual([row.time, row.svc, row.route, row.caller, '200', row.took, 'not kept']);
    expect(screen.queryByText(/401|unknown key/)).toBeNull();
    const note = screen.getByText(/six columns, and that is all of it/);
    expect(note).toHaveTextContent('Calls turned away at the door are not logged.');
  });
});
