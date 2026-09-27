import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// The page's outside inputs: the Clerk session (server + nav), Next's redirect,
// and the hub, reached over fetch.
const authMock = vi.fn();
const getUserMock = vi.fn();
vi.mock('@clerk/nextjs/server', () => ({
  auth: () => authMock(),
  clerkClient: async () => ({ users: { getUser: getUserMock } }),
}));
vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
  UserButton: () => <button type="button">Open account menu</button>,
}));
class Redirected extends Error {
  constructor(public to: string) { super(`redirect ${to}`); }
}
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Redirected(to); },
  usePathname: () => '/fleet',
}));

import { verifyAssertion } from '@worker-auth';
import FleetPage from '@/app/fleet/page';
import { AGENT_PROMPT, INSTALL_ONE_LINER } from '@/components/fieldguide/prompt';
import { NOW, SECRETS, emptyState, stateWithServices } from './fleet-fixtures';

const saved = { HUB_URL: process.env.HUB_URL, FINCH_SERVICE_SECRET: process.env.FINCH_SERVICE_SECRET };
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// A fake hub that answers only what /fleet may ask, for the signed-in user's
// own tenant: POST /api/member-context and GET /api/state. Any other path,
// method, tenant, a missing secret or a followed redirect fails the test.
let state: () => Response;
const hubCalls: string[] = [];
async function fakeHub(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (headers.get('x-finch-service') !== 'service-secret') throw new Error(`bad service secret for ${url}`);
  if ((await verifyAssertion(headers.get('x-finch-auth') ?? '', 'service-secret')) !== 'user_1') {
    throw new Error(`assertion is not for user_1 on ${url}`);
  }
  if (init.redirect !== 'manual') throw new Error('redirects must not be followed');
  const method = init.method ?? 'GET';
  hubCalls.push(`${method} ${url}`);
  if (url === 'https://hub.example.test/api/member-context' && method === 'POST') {
    const body = JSON.parse(String(init.body));
    if (body.clerkUserId !== 'user_1') throw new Error(`member-context for ${body.clerkUserId}`);
    return Response.json({ member: { id: 'mem_1', email: SECRETS.ownerEmail, role: 'owner', state: 'active' } });
  }
  if (url === 'https://hub.example.test/api/state' && method === 'GET') {
    if (init.body != null) throw new Error('GET /api/state carries no body');
    return state();
  }
  throw new Error(`unexpected hub call ${method} ${url}`);
}

async function renderPage() {
  const ui = await FleetPage();
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  hubCalls.length = 0;
  process.env.HUB_URL = 'https://hub.example.test';
  process.env.FINCH_SERVICE_SECRET = 'service-secret';
  authMock.mockResolvedValue({ userId: 'user_1' });
  state = () => Response.json(stateWithServices());
  vi.stubGlobal('fetch', vi.fn(fakeHub));
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('/fleet with services', () => {
  it('reads only the signed-in user’s own state, once', async () => {
    await renderPage();
    expect(hubCalls).toEqual([
      'POST https://hub.example.test/api/member-context',
      'GET https://hub.example.test/api/state',
    ]);
  });

  it('shows the account address and explains the slug once', async () => {
    await renderPage();
    const address = screen.getByRole('region', { name: 'Account address' });
    expect(within(address).getByText('sunny-wren-42.finchmcp.com')).toBeInTheDocument();
    expect(address).toHaveTextContent('Its first part, sunny-wren-42, is your slug');
  });

  it('shows each service with its URL, a copy button, who can call it and its machines', async () => {
    await renderPage();
    const notes = screen.getByRole('article', { name: 'notes' });
    expect(within(notes).getByText('https://sunny-wren-42.finchmcp.com/notes/mcp')).toBeInTheDocument();
    expect(within(notes).getByRole('button', { name: 'Copy the URL for notes' })).toBeInTheDocument();
    expect(notes).toHaveTextContent('Online');
    expect(notes).toHaveTextContent('Callers need a finch key, or your own OAuth sign-in');
    expect(notes).toHaveTextContent('studio-mac');
    expect(notes).toHaveTextContent('old-laptop');
    expect(notes).toHaveTextContent('offline, last seen 3h ago');
    expect(notes).toHaveTextContent('macOS · finch 1.8.0');

    const demo = screen.getByRole('article', { name: 'demo' });
    expect(demo).toHaveTextContent('Offline');
    expect(demo).toHaveTextContent('Anyone with the URL. No key or sign-in needed.');
    expect(demo).toHaveTextContent('No machine has connected yet');
    expect(demo).toHaveTextContent('No calls yet.');
  });

  it('lists recent calls with the relay’s fields: time, route, caller, status, took', async () => {
    await renderPage();
    const table = within(screen.getByRole('article', { name: 'notes' })).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Time (UTC)', 'Route', 'Caller', 'Status', 'Took',
    ]);
    const rows = within(table).getAllByRole('row').slice(1).map((tr) =>
      within(tr).getAllByRole('cell').map((td) => td.textContent),
    );
    expect(rows).toEqual([
      ['14:02:00', '/notes/mcp', 'key: claude-code', '200', '84 ms'],
      ['14:00:05', '/notes/mcp', 'you, signed in (OAuth)', '401', '12 ms'],
      ['Sep 26, 12:02', '/notes/mcp', 'finch test or call', '200', '12.3 s'],
    ]);
  });

  it('offers every action as the exact finch command, never as a browser control', async () => {
    const { container } = await renderPage();
    const commands = Array.from(container.querySelectorAll('.fl-cmd code')).map((c) => c.textContent);
    for (const expected of [
      'finch logs notes',
      'finch test notes',
      'finch connect notes --client claude-code',
      'finch auth notes public',
      'finch rm notes',
      'finch auth demo key',
      'finch rm demo',
      'finch keys revoke k_1234abcd',
      'finch keys revoke k_9876fedc',
      'finch keys mint my-client --service notes',
      'finch update',
    ]) {
      expect(commands).toContain(expected);
    }
    // Read only: no forms, inputs or links that act. Every button copies.
    expect(container.querySelector('form, input, textarea, select')).toBeNull();
    const buttons = within(container.querySelector('main')!).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect(b.getAttribute('aria-label')).toMatch(/^Copy /);
  });

  it('lists keys by label, reach and date, and tells an old machine to update', async () => {
    await renderPage();
    const keys = screen.getByRole('region', { name: 'Keys' });
    expect(keys).toHaveTextContent('claude-code');
    expect(keys).toHaveTextContent('Reaches every service · created 2026-09-20');
    expect(keys).toHaveTextContent('Reaches notes · created 2026-09-21 · expires 2026-12-01');

    const update = screen.getByRole('region', { name: 'Update available' });
    expect(update).toHaveTextContent('finch 1.8.0 is out. 1 machine still runs an older version: old-laptop (notes, 1.7.1)');
  });

  it('never renders a key value, hash, last digits, email, IP or call body', async () => {
    const { container } = await renderPage();
    const html = document.documentElement.outerHTML + container.innerHTML;
    for (const secret of Object.values(SECRETS)) {
      expect(html).not.toContain(secret);
    }
    expect(html).not.toMatch(/finch_[A-Za-z0-9]{8,}/);
  });

  it('copies a command to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the command finch rm notes' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('finch rm notes'));
    expect(await screen.findByText('Copied the command finch rm notes')).toBeInTheDocument();
  });

  it('shows its clock and marks Your fleet as the current page', async () => {
    await renderPage();
    expect(screen.getByText('14:02:05', { selector: 'time' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Your fleet' })).toHaveAttribute('aria-current', 'page');
  });
});

describe('/fleet for a new account', () => {
  beforeEach(() => {
    state = () => Response.json(emptyState());
  });

  it('greets with the install line, finch login, the agent prompt and agents.md', async () => {
    const { container } = await renderPage();
    const first = screen.getByRole('region', { name: 'Nothing published yet' });
    const commands = Array.from(first.querySelectorAll('.fl-cmd code')).map((c) => c.textContent);
    expect(commands).toEqual([
      INSTALL_ONE_LINER,
      'finch login',
      'finch add notes --service http://127.0.0.1:8000',
      'finch service install',
    ]);
    expect(first).toHaveTextContent('It opens your browser and waits for you to approve.');
    expect(within(first).getByText(AGENT_PROMPT)).toBeInTheDocument();
    expect(within(first).getByRole('button', { name: 'Copy the agent prompt' })).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: 'agents.md' })).toHaveAttribute('href', '/agents.md');
    // The address is there from the first visit; there are no services or keys to list.
    expect(screen.getByRole('region', { name: 'Account address' })).toHaveTextContent('quiet-lark-17.finchmcp.com');
    expect(screen.queryByRole('region', { name: 'Services' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Keys' })).toBeNull();
    expect(container.innerHTML).not.toContain(SECRETS.ownerEmail);
  });

  it('sets up a never-seen account with the verified email before reading it', async () => {
    let bootstrapped = false;
    const hub = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/api/member-context') && !bootstrapped) {
        const body = JSON.parse(String(init.body));
        if (body.email === undefined) return Response.json({ member: null, needsBootstrap: true });
        if (body.email !== 'new@example.com') throw new Error(`bootstrapped with ${body.email}`);
        bootstrapped = true;
      }
      return fakeHub(url, init);
    });
    vi.stubGlobal('fetch', hub);
    getUserMock.mockResolvedValue({
      primaryEmailAddressId: 'e1',
      emailAddresses: [{ id: 'e1', emailAddress: 'new@example.com', verification: { status: 'verified' } }],
    });
    await renderPage();
    expect(bootstrapped).toBe(true);
    expect(screen.getByRole('region', { name: 'Nothing published yet' })).toBeInTheDocument();
  });
});

describe('/fleet when something is off', () => {
  it('sends a lapsed session to sign-in and back to /fleet', async () => {
    authMock.mockResolvedValue({ userId: null });
    await expect(FleetPage()).rejects.toMatchObject({ to: '/sign-in?redirect_url=%2Ffleet' });
    expect(hubCalls).toEqual([]);
  });

  it('says so calmly when the hub fails, and offers the CLI instead', async () => {
    state = () => Response.json({ error: 'boom' }, { status: 500 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderPage();
    expect(screen.getByRole('heading', { name: "finch couldn't read your fleet just now" })).toBeInTheDocument();
    expect(screen.getByText('finch fleet')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('boom');
  });

  it('passes on a message meant for the person, like verifying their email', async () => {
    const hub = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/api/member-context')) return Response.json({ member: null, needsBootstrap: true });
      return fakeHub(url, init);
    });
    vi.stubGlobal('fetch', hub);
    getUserMock.mockResolvedValue({ primaryEmailAddressId: 'e1', emailAddresses: [] });
    await renderPage();
    expect(screen.getByText('Verify your email to finish setting up your account.')).toBeInTheDocument();
  });
});
