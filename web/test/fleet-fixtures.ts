// Hub /api/state fixtures for the /fleet tests, shaped like the worker's real
// TenantState (worker/src/types.ts) plus serviceBase and boxes[].online. Each
// one also carries the things the page must never print, so a leak fails.

/** 2026-09-27 14:02:05 UTC */
export const NOW = Date.UTC(2026, 8, 27, 14, 2, 5);

/** Strings that exist in the hub state but must never reach the page. */
export const SECRETS = {
  keyPlaintext: 'finch_PLAINTEXTSHOULDNEVERSHOW0123456789',
  keyHash: 'a3f1c2d4e5b6a7980011223344556677889900aabbccddeeff00112233445566',
  keyLast4: 'Q7ZK',
  ownerEmail: 'owner-private@example.com',
  logIp: '203.0.113.77',
  body: 'BODY-{"secret":"do not store"}',
  requestBody: 'REQUEST-BODY-arguments-hunter2',
} as const;

export function stateWithServices(): Record<string, unknown> {
  return {
    host: 'sunny-wren-42.finchmcp.com',
    serviceBase: 'https://sunny-wren-42.finchmcp.com',
    latestAgent: '1.8.0',
    tenant: { id: 'user_1', kind: 'personal', displayName: SECRETS.ownerEmail },
    members: [{ id: 'mem_1', email: SECRETS.ownerEmail, role: 'owner', state: 'active' }],
    settings: { subdomain: 'sunny-wren-42', org: '', keyExpiry: 'never', enforceExpiry: false },
    services: [
      {
        id: 'notes',
        label: 'notes',
        state: 'online',
        auth: 'key',
        lastSeenAt: NOW - 3_000,
        version: '1.8.0',
        boxes: [
          {
            name: 'studio-mac',
            os: 'darwin',
            version: '1.8.0',
            state: 'online',
            connected: true,
            online: true,
            outdated: false,
            lastSeenAt: NOW - 3_000,
            keys: [SECRETS.keyLast4],
          },
          {
            name: 'old-laptop',
            os: 'linux',
            version: '1.7.1',
            state: 'offline',
            connected: false,
            online: false,
            outdated: true,
            lastSeenAt: NOW - 3 * 3_600_000,
          },
        ],
        recentCalls: [
          { ts: NOW - 5_000, ago: 'now', route: '/notes/mcp', caller: 'claude-code', status: 200, ms: 84, body: SECRETS.body },
          { ts: NOW - 120_000, ago: '2m ago', route: '/notes/mcp', caller: 'oauth:user_1', status: 401, ms: 12, requestBody: SECRETS.requestBody },
          { ts: NOW - 26 * 3_600_000, ago: '1d ago', route: '/notes/mcp', caller: 'dashboard', status: 200, ms: 12_345 },
        ],
      },
      {
        id: 'demo',
        label: 'Demo site',
        state: 'offline',
        auth: 'public',
        lastSeenAt: 0,
        boxes: [],
        recentCalls: [],
      },
    ],
    keys: [
      {
        id: 'k_1234abcd',
        label: 'claude-code',
        owner: SECRETS.ownerEmail,
        created: '2026-09-20',
        scope: { all: true },
        last4: SECRETS.keyLast4,
        hash: SECRETS.keyHash,
        key: SECRETS.keyPlaintext,
      },
      {
        id: 'k_9876fedc',
        label: 'nightly-script',
        owner: SECRETS.ownerEmail,
        created: '2026-09-21',
        scope: { services: ['notes'] },
        last4: 'ZZ99',
        expiresAt: Date.UTC(2026, 11, 1),
      },
    ],
    logs: [
      { ts: NOW - 5_000, ago: 'now', cat: 'request', actor: 'claude-code', action: 'called', target: 'notes /notes/mcp', ip: SECRETS.logIp, result: 200 },
    ],
    overview: { callsToday: 2 },
  };
}

export function emptyState(): Record<string, unknown> {
  return {
    host: 'quiet-lark-17.finchmcp.com',
    serviceBase: 'https://quiet-lark-17.finchmcp.com',
    latestAgent: '1.8.0',
    members: [{ id: 'mem_1', email: SECRETS.ownerEmail, role: 'owner', state: 'active' }],
    settings: { subdomain: 'quiet-lark-17' },
    services: [],
    keys: [],
    logs: [],
  };
}
