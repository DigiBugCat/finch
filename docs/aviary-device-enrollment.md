# AviaryMCP first-run Finch enrollment

Status: local client contract and tests implemented; Worker, dashboard, and
dynamic-reconciler wiring are **not deployed**.

## Why this is a separate flow

The existing `finch login` device flow approves a box and returns a long-lived
tenant-admin CLI token. That credential can enroll, approve, remove, and change
multiple services, so it must never be handed to an AviaryMCP application.

Aviary enrollment instead authorizes exactly one service deployment manifest:

```json
{
  "service": "Media search",
  "app_path": "media",
  "routes": ["/api/v1", "/birdz", "/mcp"],
  "edge_auth": "key",
  "machine": "aviary-01",
  "machine_fingerprint": "SHA256:...",
  "expected_tenant": "tenant-id"
}
```

`expected_tenant` is optional. When configured by the SDK, the signed-in
approver must be acting for that exact tenant. When omitted, the signed-in
approver's tenant becomes the durable binding and is returned as
`approved_tenant`; finchd pins the resulting grant tenant before readiness.

`edge_auth: "key"` is the default. A request for `public` must render a second,
separate warning and confirmation in the browser. The Worker must record that
confirmation and set `public_approved: true` in the grant; the agent rejects a
public grant without it.

The application owns `service`, `app_path`, routes, and requested edge mode.
Finch adds the machine label and proof-key fingerprint. The canonical manifest
digest binds start, browser approval, poll, issued credential, and audit event.

The cross-language manifest grammar is deliberately narrow: `app_path` is a
1-63 character ASCII service slug; service/machine labels use ASCII letters,
digits, spaces, dot, underscore, and hyphen; there are 1-16 non-root route
prefixes up to 256 characters each, with path segments limited to
`[A-Za-z0-9._~-]+`. Python, Go, and Worker validators must share boundary
vectors so a human can never approve a manifest the relay later rejects.

## Trust and credential boundary

```text
AviaryMCP process             local finchd                 Finch Worker/web
----------------             ------------                 ----------------
POST /v1/enrollments  -----> validate app intent
                              generate ephemeral Ed25519 key
                              POST device/start ----------> store exact manifest + public key
<----- URL, user code, fingerprint                         show exact manifest to signed-in admin
                                                          explicit Approve (and separate Public checkbox)
                              signed device/poll ---------> verify key proof + approval
                              <--------------------------- service grant + delivery_id
                              atomically save 0600 state
                              signed delivery ack --------> consume retained grant
<----- ready + public URL    wake relay reconciler now
```

The local SDK never receives or stores:

- the 256-bit `device_code`;
- the Ed25519 private key;
- a tenant-admin CLI token;
- a join ticket;
- the service refresh credential.

The short user code is not enough to steal a grant. Finch generates an
ephemeral Ed25519 key before starting the flow, and `device/poll` signs:

```text
finch-aviary-service-enrollment-v1
poll
<device_code>
<manifest_sha256>
```

The Worker verifies the signature with the key recorded at `device/start`. TLS, a 10-minute maximum lifetime,
per-IP start throttling, bounded pending records, and one-time consumption are
still required. The proof protects a stolen code; it does not replace those
controls.

The issued refresh credential uses Finch's existing `kind: "refresh"` shape and
is scoped to tenant + exact service + exact box. It is written by `finchd` to
its existing service state directory using a same-directory `0600` temporary
file, `fsync`, and rename; the containing directory is `0700`. Completion must
signal the relay reconciler immediately. A healthy application lease must not
need to expire or restart before its new credential is used.

## Local control API

These endpoints are local Unix-socket APIs. Socket possession is the local
authority; responses contain no cloud credential.

### Start or reuse first-run enrollment

`POST /v1/enrollments`

```json
{
  "service": "Media search",
  "app_path": "media",
  "routes": ["/mcp", "/api/v1", "/birdz"],
  "edge_auth": "key"
}
```

The agent returns `200` if an exact, usable service credential already exists,
otherwise `202`:

```json
{
  "enrollment_id": "local-opaque-id",
  "state": "needs_enrollment",
  "manifest": {
    "service": "Media search",
    "app_path": "media",
    "routes": ["/api/v1", "/birdz", "/mcp"],
    "edge_auth": "key"
  },
  "machine_fingerprint": "SHA256:...",
  "authorization": {
    "verification_uri": "https://finchmcp.com/aviary/authorize",
    "verification_uri_complete": "https://finchmcp.com/aviary/authorize?code=WXYZ-2K7Q",
    "user_code": "WXYZ-2K7Q",
    "expires_at": "2026-07-10T02:10:00Z",
    "interval": 3
  }
}
```

The state vocabulary is `needs_login`/`needs_enrollment`, `pending`, `ready`,
`denied`, or `expired`. `needs_login` and `needs_enrollment` are both actionable
approval states; neither implies that a tenant-admin token will be saved.

### Observe completion

`GET /v1/enrollments/{local_enrollment_id}` returns the same non-secret status.
On completion it returns `state: "ready"` and `public_url`, but never the refresh
credential. The application may keep its dynamic registration lease alive
throughout approval.

Only one pending enrollment may own an `app_path`. Repeating an identical start
should return that pending status; a different manifest for the same path must
fail with `409 manifest_conflict`, not silently widen routes or edge access.

## Worker protocol to add

The Go contract uses these new public Worker routes:

- `POST /api/aviary/device/start`
- `POST /api/aviary/device/poll`

The signed-in web BFF uses three service-authenticated Worker routes (both
`X-Finch-Service` and a signed `X-Finch-Auth` tenant assertion are required):

- `POST /api/aviary/device/describe`
- `POST /api/aviary/device/approve`
- `POST /api/aviary/device/deny`

Describe returns the exact manifest, initiator IP/UA, age, digest, approval
state, and public-confirmation state, but never the device code, proof private
key, or refresh credential. Approve accepts `public_approved: true` only as an
explicit second confirmation for public manifests. A wrong configured tenant
fails `403 tenant_mismatch`; an existing service app path becomes a durable
denial and fails `409 app_path_collision`.

`start` receives protocol version, exact canonical manifest, its SHA-256 digest,
and an Ed25519 public key. It returns a secret `device_code`, short `user_code`,
origin-pinned verification URLs, TTL/poll interval, echoed manifest digest, and
`public_approval_required`.

`poll` receives the secret device code, manifest digest, public key, and Ed25519
signature. `approved` returns a service grant plus an opaque delivery id:

```json
{
  "status": "approved",
  "delivery_id": "short-lived-delivery-id",
  "grant": {
    "tenant": "tenant-id",
    "service": "media",
    "box": "aviary-01",
    "refresh_token": "...",
    "public_url": "https://tenant.finchmcp.com/media/mcp",
    "manifest_sha256": "...",
    "edge_auth": "key",
    "routes": ["/api/v1", "/birdz", "/mcp"],
    "machine_fingerprint": "SHA256:...",
    "public_approved": false
  }
}
```

The Worker retains and proof-gates the same delivery for a short bounded window,
so a lost HTTP response can be retried. After the agent validates every echoed
binding and atomically writes the grant, it signs a distinct `ack` statement
containing the delivery id:

```text
finch-aviary-service-enrollment-v1
ack
<device_code>
<manifest_sha256>
<delivery_id>
```

Only a successful ack consumes the Worker record;
only then does the local API report ready. The agent sanitizes
non-2xx errors and never places a raw response body in logs.

Re-enrollment for the same tenant, app path, box, route list, and edge mode is
a credential rotation rather than a collision, even though the ephemeral proof
fingerprint (and therefore manifest digest) changes. The grant carries a
per-box credential epoch. The old refresh token stays valid until the new grant
is persisted and acknowledged; acknowledgement advances the epoch and
invalidates the old token. Changed routes or edge mode still fail as a
collision instead of widening the existing service.

Verification URLs must use the exact hub origin by default. A deployment whose
dashboard has a separate origin must explicitly configure that HTTPS origin in
`AllowedVerificationOrigins`; arbitrary HTTPS hosts are rejected.

## Required Worker and web changes

Worker:

1. Add a separate Durable Object table/record kind for Aviary service device
   codes. Do not add fields to, or mint tokens through, the CLI device flow.
2. Validate and canonicalize the full manifest server-side, including safe
   segment-aware route prefixes, edge mode, lengths, and key encoding.
3. Store manifest digest, public key, initiator IP/UA, creation time, approval
   state, approver, and the separate public-approval bit.
4. Verify Ed25519 poll proofs and compare all bindings before releasing a grant.
5. Atomically claim the requested app path and register the exact box. Collisions
   must return a reviewable denial rather than silently choose another slug. In
   v1, changing an approved manifest requires explicitly releasing the service
   and approving it again (or choosing a new app path); in-place widening is not
   supported.
6. Mint the existing service+box refresh credential directly. Never mint or
   return a `kind: "cli"` assertion from this flow.
7. Redeliver an approved grant only to the same proof key until a separately
   signed delivery acknowledgement arrives; expire undelivered grants quickly.
8. Consume approved records once, expire them within ten minutes, bound table
   growth, and audit start/approve/deny/deliver/consume.

Web:

1. Add `/aviary/authorize?code=...` behind the existing signed-in admin gate.
2. `describe` must show service label, exact app path, every route, edge mode,
   machine label/fingerprint, initiator IP/UA, age, and manifest digest suffix.
3. Approval is a deliberate click. Public mode additionally requires an
   unchecked-by-default confirmation describing unauthenticated Internet access.
4. Allow denial and show collision/ownership errors without issuing a grant.
5. Do not reuse the current copy saying the box receives a 30-day CLI token.

No relay frame or public data-plane change is required for this enrollment
exchange. The dynamic relay/route allowlist still needs the separate production
agent work described in `dynamic-registration.md`.

## TTY and headless behavior

AviarySDK's `render_enrollment(status)` produces human instructions containing
the complete URL, user code, exact manifest, edge mode, and fingerprint.
`render_enrollment(status, structured=True)` produces one compact JSON event for
containers and log processors. Neither mode includes a device or refresh token.

Do not put bootstrap credentials in argv, environment variables, or normal
logs. An unattended container bootstrap, if added later, must be a separate
single-use short-TTL secret-file flow; Finch reads and unlinks the mounted file.
It must not weaken or auto-confirm the human device flow described here.

## Production gate

Before enabling this in `finch run` or `app.run(expose="finch")`:

- implement Worker/web routes and cross-language golden vectors;
- wire a local enrollment coordinator into the Unix control API;
- deduplicate exact pending manifests and reject manifest changes;
- wake/restart only the affected relay when credential persistence succeeds;
- test Worker restart, finchd restart, SDK restart, expiry, denial, collision,
  public approval, replay, stolen user/device code, changed manifest, bad proof,
  credential symlinks/modes, and untrusted verification origins;
- verify SDK structured output never contains `device_code`, proof private key,
  join ticket, CLI token, or refresh token.
