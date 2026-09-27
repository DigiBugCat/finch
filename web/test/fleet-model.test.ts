import { describe, expect, it } from 'vitest';
import { callTime, callerLabel, cmd, timeAgo, toFleetView } from '@/components/fleet/model';
import { NOW, SECRETS, emptyState, stateWithServices } from './fleet-fixtures';

describe('toFleetView: mapping the hub state for /fleet', () => {
  it('maps the account address, services, machines, calls and keys', () => {
    const view = toFleetView(stateWithServices(), NOW);

    expect(view.slug).toBe('sunny-wren-42');
    expect(view.address).toBe('sunny-wren-42.finchmcp.com');
    expect(view.base).toBe('https://sunny-wren-42.finchmcp.com');
    expect(view.latestAgent).toBe('1.8.0');
    expect(view.readAt).toBe(NOW);

    expect(view.services.map((s) => [s.id, s.url, s.auth, s.status])).toEqual([
      ['notes', 'https://sunny-wren-42.finchmcp.com/notes/mcp', 'key', 'online'],
      ['demo', 'https://sunny-wren-42.finchmcp.com/demo/mcp', 'public', 'offline'],
    ]);
    expect(view.services[1].label).toBe('Demo site');

    expect(view.services[0].machines).toEqual([
      { name: 'studio-mac', os: 'darwin', version: '1.8.0', online: true, pending: false, lastSeen: 'now', outdated: false },
      { name: 'old-laptop', os: 'linux', version: '1.7.1', online: false, pending: false, lastSeen: '3h ago', outdated: true },
    ]);

    expect(view.services[0].calls).toEqual([
      { ts: NOW - 5_000, time: '14:02:00', ago: 'now', route: '/notes/mcp', caller: 'key: claude-code', status: 200, ok: true, took: '84 ms' },
      { ts: NOW - 120_000, time: '14:00:05', ago: '2m ago', route: '/notes/mcp', caller: 'you, signed in (OAuth)', status: 401, ok: false, took: '12 ms' },
      { ts: NOW - 26 * 3_600_000, time: 'Sep 26, 12:02', ago: '1d ago', route: '/notes/mcp', caller: 'finch test or call', status: 200, ok: true, took: '12.3 s' },
    ]);

    expect(view.keys).toEqual([
      { id: 'k_1234abcd', label: 'claude-code', reach: 'all', created: '2026-09-20', expires: '' },
      { id: 'k_9876fedc', label: 'nightly-script', reach: ['notes'], created: '2026-09-21', expires: '2026-12-01' },
    ]);

    expect(view.oldMachines).toEqual([{ service: 'notes', machine: 'old-laptop', version: '1.7.1' }]);
  });

  it('keeps only the fields the page shows: no key values, hashes, last digits, emails, IPs or bodies', () => {
    const json = JSON.stringify(toFleetView(stateWithServices(), NOW));
    for (const secret of Object.values(SECRETS)) {
      expect(json).not.toContain(secret);
    }
    // Nothing named like a secret or a body survives, whatever its value.
    for (const field of ['hash', 'last4', 'key', 'body', 'requestBody', 'email', 'ip', 'logs', 'members', 'owner', 'tenant']) {
      expect(json).not.toContain(`"${field}":`);
    }
  });

  it('reads a new account with nothing published', () => {
    const view = toFleetView(emptyState(), NOW);
    expect(view.slug).toBe('quiet-lark-17');
    expect(view.services).toEqual([]);
    expect(view.keys).toEqual([]);
    expect(view.oldMachines).toEqual([]);
  });

  it('falls back to the stored address when the hub sends no serviceBase', () => {
    const state = stateWithServices();
    delete state.serviceBase;
    expect(toFleetView(state, NOW).services[0].url).toBe('https://sunny-wren-42.finchmcp.com/notes/mcp');
  });

  it('shows no URL before the hub has assigned an address', () => {
    const state = { ...emptyState(), host: '', serviceBase: '', settings: {}, services: [{ id: 'notes', state: 'offline' }] };
    const view = toFleetView(state, NOW);
    expect(view.slug).toBe('');
    expect(view.services[0].url).toBe('');
    expect(view.services[0].auth).toBe('key'); // a service without a mode is key-gated, like the hub reads it
  });

  it('does not trust the shape of what it is given', () => {
    for (const junk of [null, undefined, 'state', 42, [], { services: 'x', keys: {} }]) {
      const view = toFleetView(junk, NOW);
      expect(view.services).toEqual([]);
      expect(view.keys).toEqual([]);
    }
    const view = toFleetView({ services: [{}, { id: 7 }, { id: 'ok', boxes: 'no', recentCalls: [null] }], keys: [{ label: 'no id' }] }, NOW);
    expect(view.services.map((s) => s.id)).toEqual(['ok']);
    expect(view.services[0].machines).toEqual([]);
    expect(view.services[0].calls[0]).toMatchObject({ route: '', status: 0, ok: false, time: '—' });
    expect(view.keys).toEqual([]);
  });

  it('marks a joined-but-unapproved machine as waiting, and never online on the hub’s say-so alone', () => {
    const state = stateWithServices();
    const svc = (state.services as any[])[0];
    svc.state = 'pending';
    svc.boxes = [{ name: 'new-box', state: 'pending', connected: true, online: false }];
    const view = toFleetView(state, NOW);
    expect(view.services[0].status).toBe('waiting');
    expect(view.services[0].machines[0]).toMatchObject({ online: false, pending: true });
    // `online` must be the literal true the hub sends, not any truthy value.
    svc.boxes = [{ name: 'box', state: 'online', online: 'yes' }];
    expect(toFleetView(state, NOW).services[0].machines[0].online).toBe(false);
  });
});

describe('fleet helpers', () => {
  it('words callers as a person reads them', () => {
    expect(callerLabel('claude-code')).toBe('key: claude-code');
    expect(callerLabel('oauth:user_2mXf8Q')).toBe('you, signed in (OAuth)');
    expect(callerLabel('anonymous')).toBe('no key (public)');
    expect(callerLabel('dashboard')).toBe('finch test or call');
    expect(callerLabel('')).toBe('unknown');
  });

  it('formats times in UTC, relative to the read', () => {
    expect(callTime(NOW, NOW)).toBe('14:02:05');
    expect(callTime(Date.UTC(2026, 8, 26, 23, 59, 59), NOW)).toBe('Sep 26, 23:59');
    expect(timeAgo(0, NOW)).toBe('never');
    expect(timeAgo(NOW - 45_000, NOW)).toBe('45s ago');
    expect(timeAgo(NOW - 3 * 86_400_000, NOW)).toBe('3d ago');
  });

  it('builds the exact CLI commands, quoting only what needs it', () => {
    expect(cmd.logs('notes')).toBe('finch logs notes');
    expect(cmd.rm('notes')).toBe('finch rm notes');
    expect(cmd.revoke('k_1234abcd')).toBe('finch keys revoke k_1234abcd');
    expect(cmd.auth('notes', 'public')).toBe('finch auth notes public');
    expect(cmd.connect('notes')).toBe('finch connect notes --client claude-code');
    expect(cmd.mint('notes')).toBe('finch keys mint my-client --service notes');
    expect(cmd.rm("it's mine; rm -rf ~")).toBe("finch rm 'it'\\''s mine; rm -rf ~'");
  });
});
