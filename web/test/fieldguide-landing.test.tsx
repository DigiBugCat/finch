import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

import Home from '@/app/page';
import AgentSession, { SESSION } from '@/components/fieldguide/AgentSession';
import { logRows } from '@/components/fieldguide/SightingLog';

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
    render(<Home />);
    const group = screen.getByRole('group', { name: 'Who gets in' });
    const key = within(group).getByRole('button', { name: 'Key' });
    const oauth = within(group).getByRole('button', { name: 'Sign in' });
    const pub = within(group).getByRole('button', { name: 'Public' });

    expect(key).toHaveAttribute('aria-pressed', 'true');
    expect(oauth).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('finch keys mint cursor --service notes')).toBeInTheDocument();

    fireEvent.click(pub);
    expect(pub).toHaveAttribute('aria-pressed', 'true');
    expect(key).toHaveAttribute('aria-pressed', 'false');
    const openCmd = screen.getByText('finch add demo --service http://127.0.0.1:3000 --public');
    assertContractCommand(openCmd.textContent!);
    expect(screen.getByRole('img', { name: 'Garden gate: anyone can walk in' })).toBeInTheDocument();

    fireEvent.click(oauth);
    expect(oauth).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Sign in at the gate' })).toBeInTheDocument();
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

  const typed = (c: HTMLElement) => c.querySelectorAll('.fg-term-lines > span:not(.fg-term-cursor)').length;

  it('holds the finished session, phone approved, for reduced motion', () => {
    reduced = true;
    const { container } = render(<AgentSession />);
    expect(typed(container)).toBe(SESSION.length);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(typed(container)).toBe(SESSION.length);
    expect(container.querySelector('.fg-phone')).toHaveClass('is-shown');
    expect(screen.getByText('Approved ✓')).toBeInTheDocument();
  });

  it('types the session out line by line when motion is allowed', () => {
    reduced = false;
    const { container } = render(<AgentSession />);
    expect(typed(container)).toBe(0);
    act(() => { vi.advanceTimersByTime(650 * 3); });
    expect(typed(container)).toBe(3);
    expect(container.querySelector('.fg-phone')).not.toHaveClass('is-shown');
    act(() => { vi.advanceTimersByTime(650 * 3); });
    expect(container.querySelector('.fg-phone')).toHaveClass('is-shown');
    expect(screen.getByText('Approve')).toBeInTheDocument();
  });
});

describe('sighting log rows', () => {
  it('is deterministic, newest first, three seconds apart, with occasional 401s', () => {
    const rows = logRows(0);
    expect(rows).toHaveLength(7);
    expect(rows[0].time).toBe('14:04:05');
    expect(rows[1].time).toBe('14:04:02');
    expect(logRows(0)).toEqual(rows);
    expect(rows.every((r) => r.status === '200' && !r.denied)).toBe(true);
    const later = logRows(4); // row 44 is a turned-away key
    const denied = later.filter((r) => r.denied);
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ status: '401', caller: 'unknown key' });
  });
});
