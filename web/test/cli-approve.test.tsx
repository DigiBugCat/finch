import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// Clerk and the router are the page's only outside inputs; stub them to a
// signed-in owner and a ?code= link.
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({ useSearchParams: () => search }));
vi.mock('@clerk/nextjs', () => ({
  useUser: () => ({ user: { primaryEmailAddress: { emailAddress: 'owner@example.com' }, username: null } }),
  UserButton: () => <div data-testid="user-button" />,
}));

import CliApprove from '@/components/CliApprove';

const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
type Call = { url: string; body: Record<string, unknown> };

// A strict stand-in for the two BFF routes: anything the page should never
// send (wrong method/route/content type, a malformed code, stray fields) is a
// 400, so the test fails loudly instead of silently "approving".
function hub(known: Record<string, { reqIp: string; reqUa: string }>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const bad = (why: string) => new Response(JSON.stringify({ error: why }), { status: 400 });
    if (init?.method !== 'POST') return bad('method');
    if (new Headers(init.headers).get('content-type') !== 'application/json') return bad('content-type');
    let body: Record<string, unknown>;
    try { body = JSON.parse(String(init.body)); } catch { return bad('json'); }
    calls.push({ url, body });
    const code = body.userCode;
    if (typeof code !== 'string' || !CODE_RE.test(code)) return bad('userCode');
    if (url === '/api/finch/cli-describe') {
      if (Object.keys(body).join() !== 'userCode') return bad('fields');
      const origin = known[code];
      return Response.json(origin
        // Exactly the fields cleanDescribeResponse forwards: every account is
        // one person's since #47, so the hub names no account here.
        ? { found: true, ...origin, ageSeconds: 12 }
        : { found: false });
    }
    if (url === '/api/finch/cli-approve') {
      if (Object.keys(body).sort().join() !== 'email,userCode') return bad('fields');
      if (!known[code]) return new Response(JSON.stringify({ error: 'no such login' }), { status: 404 });
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('/cli approval page', () => {
  beforeEach(() => { search = new URLSearchParams(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('shows where a prefilled login started and approves it only on a click', async () => {
    search = new URLSearchParams('code=qktm-8fwd');
    const calls = hub({ 'QKTM-8FWD': { reqIp: '203.0.113.7', reqUa: 'finch/1.4.0 (darwin)' } });
    render(<CliApprove />);

    expect(screen.getByRole('textbox', { name: 'Login code' })).toHaveValue('QKTM-8FWD');
    await screen.findByText(/203\.0\.113\.7 · finch\/1\.4\.0 \(darwin\)/);
    // The token acts as the signed-in user's own account, named by their email.
    expect(screen.getByText(/This grants a CLI token/)).toHaveTextContent('acting as owner@example.com.');
    expect(screen.queryByText(/team account|personal account/)).toBeNull();
    // Looking the code up never approves it.
    expect(calls.map((c) => c.url)).toEqual(['/api/finch/cli-describe']);

    fireEvent.click(screen.getByRole('button', { name: 'Approve box' }));
    await screen.findByRole('status');
    expect(screen.getByRole('status')).toHaveTextContent('✓ Box approved');
    expect(calls.at(-1)).toEqual({
      url: '/api/finch/cli-approve',
      body: { userCode: 'QKTM-8FWD', email: 'owner@example.com' },
    });
  });

  it('keeps Approve disabled for a code with no active login', async () => {
    const calls = hub({});
    render(<CliApprove />);
    const button = screen.getByRole('button', { name: 'Approve box' });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox', { name: 'Login code' }), { target: { value: 'zzzz-9999' } });
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent(/No active login for that code/);
    expect(button).toBeDisabled();
    expect(calls.every((c) => c.url === '/api/finch/cli-describe')).toBe(true);
  });

  it('does not look up a partial code', async () => {
    const calls = hub({});
    render(<CliApprove />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Login code' }), { target: { value: 'QKTM-8F' } });
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toEqual([]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve box' })).toBeDisabled());
  });

  it('keeps the anti-phishing warning and points revocation at finch revoke-tokens', () => {
    hub({});
    render(<CliApprove />);
    const warning = screen.getByText(/If someone sent you this code, do not approve it/);
    expect(warning).toHaveTextContent(/Only approve a code you just started with finch login on a box you control/);
    expect(warning).toHaveTextContent(/it would give their terminal access to your account/);
    expect(warning).toHaveTextContent(/You can revoke every CLI token anytime with finch revoke-tokens/);
  });
});
