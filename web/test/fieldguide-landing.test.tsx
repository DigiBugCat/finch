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
import AgentSession, { FIRST_STEP, SESSION } from '@/components/fieldguide/AgentSession';
import { LOG_COLUMNS, LOG_COMMAND, logRows } from '@/components/fieldguide/SightingLog';
import { breakableParts } from '@/components/fieldguide/GateDial';
import { SITEMAP_PATHS } from '@/app/site-paths';

// The one paste for humans, verbatim from the shared CLI contract. Pinned here
// as a literal (not imported) so a drift in the component fails this test.
const CONTRACT_PROMPT =
  'Read https://finchmcp.com/agents.md and use finch to publish my MCP server on http://127.0.0.1:8000 as notes. Show me the sign-in link when you get it. Run it as a background service, check it with finch test, then connect it to this agent.';

// Every finch command the landing may show, per the shared CLI contract (plus
// the existing `keys mint` and `logs`). Anything else is a drifted command.
const NAME = '[a-z][a-z0-9-]*';
const URL = 'https?://[^\\s]+';
const FINCH_COMMANDS = [
  new RegExp(`^finch login$`),
  new RegExp(`^finch login --start( --json)?( --hub ${URL})?$`),
  new RegExp(`^finch login --poll( --json)?$`),
  new RegExp(`^finch add ${NAME} --service ${URL}( --public)?( --forward-all)?( --json)?$`),
  new RegExp(`^finch service (install|uninstall|status)( --json)?$`),
  new RegExp(`^finch test ${NAME}( --json)?$`),
  new RegExp(`^finch connect ${NAME} --client (claude-code|cursor|codex|json)( --json)?$`),
  new RegExp(`^finch keys mint ${NAME} --service ${NAME}$`),
  new RegExp(`^finch logs ${NAME}( --limit [0-9]+)?( --json)?$`),
];

// The account address the examples use must look like a real one: the hub
// names every account <word>-<bird>-<NN> (tenant-do.ts ensureDefaultSlug), and
// there is no command to choose one.
const REAL_SLUG = /^[a-z]+-(finch|wren|robin|sparrow|lark|swift|martin|thrush|siskin|tanager|plover|kestrel)-[1-9][0-9]$/;
const EXAMPLE_ADDRESS = 'sunny-wren-42.finchmcp.com/notes/mcp';

/** The top-level keys of a JSON line the way the CLI prints it, where the
 *  example may trim fields with "…". Throws on a line that is not an object. */
function topLevelKeys(line: string): string[] {
  if (!line.startsWith('{') || !line.endsWith('}')) throw new Error(`not a JSON object line: ${line}`);
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      const end = line.indexOf('"', i + 1);
      if (end < 0) throw new Error(`unterminated string in ${line}`);
      if (depth === 1 && line[end + 1] === ':') keys.push(line.slice(i + 1, end));
      i = end;
    } else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
  }
  if (depth !== 0) throw new Error(`unbalanced JSON line: ${line}`);
  return keys;
}

/** The keys of every object nested below the top level of a JSON line (in
 *  the order written), one array per object. Throws on an unbalanced line. */
function nestedObjectKeys(line: string): string[][] {
  topLevelKeys(line); // same shape checks
  const out: string[][] = [];
  const stack: (string[] | null)[] = []; // null for an array
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      const end = line.indexOf('"', i + 1);
      const top = stack[stack.length - 1];
      if (top && line[end + 1] === ':') top.push(line.slice(i + 1, end));
      i = end;
    } else if (ch === '{') stack.push([]);
    else if (ch === '[') stack.push(null);
    else if (ch === '}' || ch === ']') {
      const done = stack.pop();
      if (done && stack.length > 0) out.push(done);
    }
  }
  return out;
}

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
    expect(() => assertContractCommand('finch add demo --service http://127.0.0.1:3000 --public --forward-all')).not.toThrow();
    expect(() => assertContractCommand('finch add demo --service http://127.0.0.1:3000 --forward-all --public')).toThrow();
  });

  it('reads top-level JSON keys the way the CLI orders them, and rejects broken lines', () => {
    expect(topLevelKeys('{"schema_version":1,"ok":true,"tools":[{"name":"a",…},…]}')).toEqual(['schema_version', 'ok', 'tools']);
    expect(() => topLevelKeys('{"schema_version":1,"tools":[')).toThrow();
    expect(() => topLevelKeys('not json')).toThrow();
  });

  it('reads the keys of nested objects, so an unsorted tool object is caught', () => {
    expect(nestedObjectKeys('{"schema_version":1,"tools":[{"name":"a",…},…]}')).toEqual([['name']]);
    expect(nestedObjectKeys('{"a":{"z":1,"b":{"c":2}},"d":[{"y":1},{"x":2}]}')).toEqual([['c'], ['z', 'b'], ['y'], ['x']]);
    expect(nestedObjectKeys('{"schema_version":1,"ok":true}')).toEqual([]);
    expect(() => nestedObjectKeys('{"tools":[{"name":"a"}')).toThrow();
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
    // The agent walks the whole contract with --json, as agents.md tells it to:
    // start, poll, add, service, test, connect.
    expect(cmds).toEqual([
      '$ curl -fsSL https://finchmcp.com/install | sh',
      '$ finch login --start --json',
      '$ finch login --poll --json',
      '$ finch add notes --service http://127.0.0.1:8000 --json',
      '$ finch service install --json',
      '$ finch test notes --json',
      '$ finch connect notes --client claude-code --json',
    ]);
  });

  it('shows only output the CLI really prints', () => {
    // The installer's own line, word for word (worker/src/install-script.ts).
    const outs = SESSION.filter((l) => l.kind === 'out');
    expect(outs[0].text).toMatch(/^finch: installed to \/[^\s]+\/finch$/);
    expect(SESSION.map((l) => l.text).join('\n')).not.toMatch(/installed finch \d/);

    // Every JSON line: schema_version first, then the rest in the order Go's
    // encoder prints a map (alphabetical), trimmed only with "…".
    const json = outs.slice(1);
    expect(json).toHaveLength(6);
    for (const l of json) {
      const keys = topLevelKeys(l.text);
      expect(keys[0]).toBe('schema_version');
      expect(keys.slice(1)).toEqual([...keys.slice(1)].sort());
      // Objects nested inside (each tool finch test lists) are Go maps too,
      // so their keys come out fully alphabetical: "description" before "name".
      for (const inner of nestedObjectKeys(l.text)) expect({ line: l.text, keys: inner }).toEqual({ line: l.text, keys: [...inner].sort() });
    }
    const test = json.find((l) => l.text.includes('"tools"'))!;
    expect(nestedObjectKeys(test.text)).toEqual([['description', 'name']]);
    // An untrimmed line parses in full; the poll result is exactly the CLI's.
    const poll = json.find((l) => l.text.includes('"status"'))!;
    expect(JSON.parse(poll.text)).toEqual({ schema_version: 1, account: 'you@example.com', status: 'approved' });
    // The URLs the agent reads back use a real-looking account address.
    const withUrl = json.filter((j) => j.text.includes('finchmcp.com/notes'));
    expect(withUrl.length).toBe(2);
    for (const l of withUrl) expect(l.text).toContain(`"url":"https://${EXAMPLE_ADDRESS}"`);
    expect(EXAMPLE_ADDRESS.split('.')[0]).toMatch(REAL_SLUG);
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
    expect(gateCode()).toBe('finch add demo --service http://127.0.0.1:3000 --public --forward-all');
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
    expect(live).toHaveTextContent('finch add demo --service http://127.0.0.1:3000 --public --forward-all');
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
      ['https://sunny-wren-42.finchmcp.com/', 'notes/', 'mcp'],
      ['finch', 'add', 'demo', '--service', 'http://127.0.0.1:3000', '--public', '--forward-all'],
    ]);
    expect(container.querySelector('#gate code')!.textContent).toBe('finch add demo --service http://127.0.0.1:3000 --public --forward-all');
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
    const addr = screen.getByText(EXAMPLE_ADDRESS, { selector: '.fg-band > span' });
    expect(addr.textContent).toBe(addr.textContent!.toLowerCase());
  });

  it('labels the band address and its anatomy for screen readers', () => {
    render(<Home />);
    expect(screen.getByText(EXAMPLE_ADDRESS, { selector: '.fg-band > span' })).toBeInTheDocument();
    const terms = screen.getAllByRole('term').map((t) => t.textContent);
    expect(terms).toEqual(['sunny-wren-42', '.finchmcp.com', '/notes', '/mcp']);
    const defs = screen.getAllByRole('definition').map((d) => d.textContent);
    expect(defs).toEqual(['your account address (finch picks it)', 'the relay', 'the name you chose', 'where clients connect']);
  });

  it('never sells a hand-picked account name or an address "for life"', () => {
    // Account addresses are assigned (<word>-<bird>-<NN>) and cannot be
    // renamed, so no example may show a chosen name like the old "maray".
    const { container } = render(<Home />);
    const text = container.textContent!;
    expect(text).not.toMatch(/maray/i);
    expect(text).not.toMatch(/for life/i);
    const hosts = [...text.matchAll(/([a-z0-9-]+)\.finchmcp\.com\/[a-z]/g)].map((m) => m[1]);
    expect(hosts.length).toBeGreaterThan(3);
    for (const h of hosts) expect(h).toMatch(REAL_SLUG);
  });

  it('prices it Free and Enterprise with working calls to action', () => {
    render(<Home />);
    expect(screen.getByRole('link', { name: 'Create a free account' })).toHaveAttribute('href', '/sign-up');
    // Sign-up lands on the fleet page, and the card says so.
    expect(screen.getByRole('link', { name: 'Create a free account' }).closest('article')).toHaveTextContent(/fleet page/);
    expect(screen.getByRole('link', { name: 'Email us' })).toHaveAttribute('href', 'mailto:hello@aviary.run');
    // The one contact address is on another brand's domain, so the card says whose it is.
    expect(screen.getByRole('link', { name: 'Email us' }).closest('article')).toHaveTextContent(
      'Email Aviary, the maker of finch, at hello@aviary.run',
    );
  });

  it('says finch is open source: hero, pricing and footer', () => {
    const { container } = render(<Home />);
    expect(container.querySelector('.fg-hero-eyebrow')).toHaveTextContent(/Open source \(MIT\)/);
    const oss = screen.getByRole('complementary', { name: 'Open source · MIT' });
    expect(oss).toHaveTextContent('Free and open source.');
    expect(within(oss).getByRole('link', { name: 'Source on GitHub' })).toHaveAttribute('href', 'https://github.com/DigiBugCat/finch');
    // "Host it yourself" appears exactly when the self-host guide is a listed
    // (and so, per site-basics.test, existing) page; never a link to a 404.
    const selfHost = within(oss).queryByRole('link', { name: 'Host it yourself' });
    if ((SITEMAP_PATHS as readonly string[]).includes('/docs/self-host')) {
      expect(selfHost).toHaveAttribute('href', '/docs/self-host');
    } else {
      expect(selfHost).toBeNull();
    }
    for (const a of container.querySelectorAll('a[href^="/docs/"]')) {
      const path = a.getAttribute('href')!.split('#')[0];
      expect({ path, listed: (SITEMAP_PATHS as readonly string[]).includes(path) }).toEqual({ path, listed: true });
    }
    const footer = container.querySelector('footer')!;
    expect(footer).toHaveTextContent(/free and open source, under the MIT license/);
    // The footer no longer name-drops a second brand without explaining it.
    expect(footer).not.toHaveTextContent(/Aviary/);
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

  // The terminal's rows, in order: only the lines typed so far, then exactly
  // one cursor. Untyped lines are not laid out at all (the old hidden
  // placeholders made the box as tall as the whole transcript, and it opened
  // mostly empty on every loop).
  const rows = (c: HTMLElement) =>
    [...c.querySelectorAll('.fg-term-lines > span')].map((s) =>
      s.classList.contains('fg-term-cursor') ? 'CURSOR' : s.textContent,
    );
  const typed = (c: HTMLElement) => rows(c).filter((r) => r !== 'CURSOR').length;
  const expectFrame = (c: HTMLElement, n: number) =>
    expect(rows(c)).toEqual([...SESSION.slice(0, n).map((l) => l.text), 'CURSOR']);

  it('holds the finished session, phone approved, for reduced motion', () => {
    reduced = true;
    const { container } = render(<AgentSession />);
    expectFrame(container, SESSION.length);
    act(() => { vi.advanceTimersByTime(5000); });
    expectFrame(container, SESSION.length);
    expect(container.querySelector('.fg-phone')).toHaveClass('is-shown');
    expect(screen.getByText('Approved ✓')).toBeInTheDocument();
  });

  it('opens each loop mid-session, at the approval, and types the rest line by line', () => {
    reduced = false;
    const { container } = render(<AgentSession />);
    // The loop opens with the install and `finch login --start` already typed;
    // the next line is the agent asking you to approve.
    const ask = SESSION.findIndex((l) => l.kind === 'hand');
    expect(FIRST_STEP).toBe(ask);
    expect(SESSION.slice(0, FIRST_STEP).map((l) => l.text)).toEqual(
      expect.arrayContaining(['$ curl -fsSL https://finchmcp.com/install | sh', '$ finch login --start --json']),
    );
    expectFrame(container, FIRST_STEP);
    expect(container.querySelector('.fg-phone')).not.toHaveClass('is-shown');
    // One beat later the agent asks, and the phone slides in...
    act(() => { vi.advanceTimersByTime(650); });
    expectFrame(container, FIRST_STEP + 1);
    expect(container.querySelector('.fg-phone')).toHaveClass('is-shown');
    expect(screen.getByText('Approve')).toBeInTheDocument();
    // ...and turns green once the poll comes back approved.
    const approvedAt = SESSION.findIndex((l) => l.text.includes('"status":"approved"')) + 1;
    act(() => { vi.advanceTimersByTime(650 * (approvedAt - (FIRST_STEP + 1))); });
    expectFrame(container, approvedAt);
    expect(screen.getByText('Approved ✓')).toBeInTheDocument();
    // It finishes, rests three beats on the finished session, then starts over
    // at the same opening frame (phone hidden again).
    act(() => { vi.advanceTimersByTime(650 * (SESSION.length - approvedAt)); });
    expectFrame(container, SESSION.length);
    act(() => { vi.advanceTimersByTime(650 * 3); });
    expectFrame(container, SESSION.length);
    act(() => { vi.advanceTimersByTime(650); });
    expectFrame(container, FIRST_STEP);
    expect(typed(container)).toBe(FIRST_STEP);
    expect(container.querySelector('.fg-phone')).not.toHaveClass('is-shown');
  });

  it('keeps the terminal a fixed height while it types, and natural height for reduced motion', () => {
    // jsdom has no layout, so this pins the stylesheet rules the typing relies
    // on (checked in a browser at 1200px and 390px).
    const css = readFileSync(resolve(import.meta.dirname, '../components/fieldguide/landing.css'), 'utf8');
    const rule = (sel: string, from = css) => {
      const m = from.match(new RegExp(`(?:^|[}\\s])${sel.replace(/[.]/g, '\\.')}\\{([^}]*)\\}`));
      if (!m) throw new Error(`no rule for ${sel}`);
      return m[1];
    };
    expect(rule('.fg-term')).toMatch(/(?:^|;\s*)height:\d+px/);
    // The window clips from the top once the lines outgrow it, keeping the
    // newest line in view; the lines fill it from the top until then.
    expect(rule('.fg-term-window')).toMatch(/overflow:hidden/);
    expect(rule('.fg-term-window')).toMatch(/justify-content:flex-end/);
    expect(rule('.fg-term-lines')).toMatch(/min-height:100%/);
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\s*\.fg-term\{height:auto\}\s*\}/);
    expect(css).not.toMatch(/fg-term-pending/);
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

describe('sighting log', () => {
  it('shows the rows finch logs lists: one service, newest first, every row under that service', () => {
    const rows = logRows();
    expect(rows).toHaveLength(7);
    // Local time, date first, the way finch logs prints it (2006-01-02 15:04:05).
    expect(rows[0].time).toBe('2026-09-27 14:02:05');
    for (const r of rows) expect(r.time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    for (const r of rows) expect(r.took).toMatch(/^\d+ms$/);
    const secs = rows.map((r) => r.time.slice(11).split(':').map(Number)).map(([h, m, x]) => h * 3600 + m * 60 + x);
    for (let k = 1; k < secs.length; k++) expect(secs[k]).toBeLessThan(secs[k - 1]);
    for (const r of rows) {
      expect(r.route.startsWith('/notes/')).toBe(true);
      // Rejected calls (no key, a bad key) return before recordCall, so the
      // log shows none of them.
      expect(r.status).toBe('200');
      expect(r.caller).not.toMatch(/unknown|denied|rejected/);
    }
    // Caller labels as the hub stores them: connect's "<client> on <machine>",
    // a minted key's label, or oauth:<user id>.
    expect(rows.map((r) => r.caller)).toEqual(expect.arrayContaining(['claude-code on studio', 'oauth:user_2mXf8Q']));
    assertContractCommand(LOG_COMMAND);
  });

  it('is presented as finch logs output, not a live feed nobody can open', () => {
    const { container } = render(<Home />);
    const log = container.querySelector('.fg-log')!;
    expect(log).toHaveTextContent(`$ ${LOG_COMMAND}`);
    expect(log).not.toHaveTextContent(/live|recording/i);
    // No ticking clock: the plate does not hydrate.
    expect(log.querySelector('.iw-blink')).toBeNull();
  });

  it('shows exactly the columns finch logs prints, in its order, and no others', () => {
    const { container } = render(<Home />);
    const table = screen.getByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent!.toUpperCase());
    // finch logs' header line, verbatim (agent/core cli_lifecycle.go runLogs):
    // TIME, STATUS, TOOK, CALLER, ROUTE. No Body column: the CLI has none.
    expect(headers).toEqual(['TIME', 'STATUS', 'TOOK', 'CALLER', 'ROUTE']);
    expect(LOG_COLUMNS.map((c) => c.key)).toEqual(['time', 'status', 'took', 'caller', 'route']);
    const body = within(table).getAllByRole('row').slice(1);
    const all = logRows();
    expect(body).toHaveLength(all.length);
    body.forEach((tr, k) => {
      const r = all[k];
      expect(within(tr).getAllByRole('cell').map((c) => c.textContent)).toEqual([r.time, r.status, r.took, r.caller, r.route]);
    });
    expect(container.querySelector('.fg-log')).not.toHaveTextContent(/not kept|body$/i);
    expect(screen.queryByText(/401|unknown key/)).toBeNull();
    // That bodies are not kept is a handwritten note outside the table, and
    // its count matches the columns.
    const note = screen.getByText(/fields per call, and that is all of it/);
    expect(table.contains(note)).toBe(false);
    expect(note).toHaveTextContent(/^Five fields per call/);
    expect(note).toHaveTextContent(/no request or response bodies/);
    expect(headers).toHaveLength(5);
    expect(note).toHaveTextContent('Calls refused for a missing or wrong key are not logged.');
  });
});
