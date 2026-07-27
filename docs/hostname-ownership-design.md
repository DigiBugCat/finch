# Custom-hostname ownership verification — design note

Status: **not implemented**. Written up from the 2026-07-26 security review
(finding 5, LOW), which was confirmed but reduced in scope. This is the design
for the fix, not a description of shipped behaviour.

## The gap

`POST /api/finch/hostnames` writes an arbitrary hostname into the **global**
RouterDO with no proof that the caller controls the domain.

The checks that do run (`worker/src/api.ts` ~1042-1068):

- `JOIN_LIMIT` rate limit, keyed `hostnames:${tenant}` (10/60s — still ~14.4k/day)
- `validateCustomHostname` — syntax only
- reserved-family denylist for `finchmcp.com` / `workers.dev`
- the vanity-suffix gate (`VANITY_TENANT`)

None of them establishes ownership. `requireAdmin()` is not a barrier here
either: sign-up is open, and a first sign-in bootstraps the caller as `owner` of
their own tenant, so every self-signed-up account clears it.

Registration is first-come (`router-do.ts` ~159-163), `routerUnregister` fails
closed for non-owners (~183), and the RouterDO op switch exposes no operator
override — so a squat is durable and clearing one means DO surgery. The
maintainers already note this at `docs/security-and-deploy.md:187-188` and treat
disputed registrations as an out-of-band support path.

## What actually bites today, and what does not

**Live: squatting-denial.** An attacker registers `mcp.victimcorp.com`; the
rightful owner gets a permanent 409 and cannot onboard.

**Not live: traffic capture.** The `*/*` catch-all route that BYO hostnames
require is commented out in `worker/wrangler.jsonc` (~236-264), and the attacker
cannot point the victim's DNS at Finch. This is a *deployment gap, not a
control* — `docs/security-and-deploy.md:180-183` instructs ops to add that route.

**Not live: resource abuse.** `provisionCfHostname` no-ops unless both
`CF_API_TOKEN` and `CF_SAAS_ZONE_ID` are set, and a Cloudflare rejection rolls
the RouterDO row back (`api.ts` ~1072-1075).

> **DV is not the missing control.** `api.ts:180` requests
> `ssl: { method: "http", type: "dv" }`. HTTP DV completes once the hostname's
> DNS points at the SaaS zone — it proves *DNS was pointed at Finch*, not that
> the registrant owns the domain. In a dangling-CNAME or DNS-first onboarding
> flow it would not stop a squatter. Do not treat enabling CF-for-SaaS as
> closing this.

**Therefore:** pre-planted rows persist across deploys, so today's LOW becomes a
MEDIUM the moment the catch-all route goes live. Fix this **before** that route
is enabled, not after.

## Proposed design

A hostname gets a `pending → verified` lifecycle; only `verified` rows resolve
traffic.

### 1. RouterDO row state

Add to the stored value: `state: "pending" | "verified"`, `challenge: string`,
`claimedAt: number`, `verifiedAt?: number`.

`resolveTenant` (`worker/src/index.ts` ~565-580) must serve **only** `verified`
rows. This is the load-bearing change — it is what makes a pending squat inert
even if the catch-all route is live.

### 2. Challenge issuance

On `POST /api/hostnames`, register the row `pending` with a challenge token
derived as `HMAC(TICKET_SECRET, tenantId || hostname)`, truncated — deterministic,
so a retry returns the same value and no extra storage is needed. Return the
record the operator must publish:

```
_finch-challenge.<hostname>  TXT  "finch-verify=<token>"
```

A `pending` row must **not** block another tenant from claiming the same
hostname — otherwise the denial bug survives the fix. Allow multiple concurrent
pending claims per hostname, keyed by tenant; the first to verify wins and the
rest are dropped.

### 3. Verification

`POST /api/hostnames/:hostname/verify` resolves the TXT record via DNS-over-HTTPS
(`https://cloudflare-dns.com/dns-query`, `application/dns-json`) and promotes the
row to `verified` on an exact token match.

Note this is the scan's one intentional exception to "the scan makes no network
calls" — it is product code, not scan code, but flag it in review: it is the
only outbound DNS dependency in the Worker. Cache negative results briefly and
rate-limit the endpoint, or it becomes a DoH amplifier.

Only after `verified` should `provisionCfHostname` run. That also stops the
platform's CF quota being spent on unverified claims.

### 4. Expiry and cleanup

- `pending` rows expire after 7 days via a DO alarm — this alone would have
  made the current squat self-healing.
- Add an operator-only `forceUnregister` op so disputed `verified` rows can be
  cleared without DO surgery. Gate it on `FINCH_SERVICE_SECRET` and log it.

### 5. Migration

Existing rows must be grandfathered to `verified` — otherwise every live custom
hostname breaks on deploy. Do this as an explicit one-shot migration op with a
recorded count, not a lazy default, so "unverified but grandfathered" is
auditable rather than invisible.

## Test plan

- pending row does not resolve traffic (the core assertion)
- two tenants may hold concurrent pending claims; first verified wins
- wrong / absent / malformed TXT leaves the row pending
- verified row resolves and survives a redeploy
- pending row expires on the alarm
- grandfathered rows resolve after migration
- verify endpoint is rate-limited

## Also outstanding

**`/api/finch/state` service-inventory filtering** (from finding 2, partially
fixed). A member no longer receives keys, ACL, access requests, settings, the
roster, or box address/relay. They *still* see the service and box inventory for
services no ACL grants them.

Filtering that correctly needs `evalIdentAccess` / `userIdentities`, which live
in the TenantDO — the web layer would have to reimplement identity expansion and
risks wrongly hiding services a member can legitimately reach. The right shape is
for `getState` to take the caller's role and member identity and project in the
DO. That also requires `hubFetchAs` to transmit member identity, which it
deliberately does not do today (it sends only a signed `{tenant}` assertion), so
it is a real interface change rather than a patch.
