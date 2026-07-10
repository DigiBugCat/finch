# Dynamic local service registration

Status: implemented local pilot contract. `finch run` reconciles static
`finch.yml` services and memory-only AviaryMCP leases without changing the
Finch cloud protocol.

## Purpose and boundary

An AviaryMCP process should be able to tell an already-running `finchd` what it
wants published. The application owns its service name, local upstream, and
exposed route prefixes. Finch continues to own box credentials, enrollment,
the public assignment, and relay lifecycle.

`finch.yml` remains the persistent compatibility surface for services that do
not use AviaryMCP. Dynamic registrations are memory-only leases: they vanish
when their application or `finchd` exits.

## Local transport and authority

The API is HTTP/1.1 over a Unix domain socket. The default is
`$XDG_RUNTIME_DIR/finch/control.sock`, falling back to `~/.finch/run/control.sock`.
The socket directory is `0700` and the socket is `0600`. A container deployment
may deliberately use `0660` plus a dedicated group on a shared `/run/finch`
volume. Possession of socket access is the authentication mechanism; there is
no bearer secret to copy into application configuration.

Socket access is a **full control-plane trust boundary**, not per-application
isolation. The supported production pattern is one Finch sidecar and one
dedicated supplemental GID per application. Mutually untrusted applications
must not share a control socket or GID. A future shared-daemon design must bind
registrations to Unix peer credentials (`SO_PEERCRED`) or use per-application
sockets/capabilities before claiming isolation.

The listener must reject TCP binding. On platforms without Unix sockets, the
control interface is unavailable until an equivalently local authenticated
transport is designed.

The Go listener is `NewUnixControlListener`. It requires an absolute socket
path in an owner-controlled `0700` directory, or explicit `0750` owner/group
search access for container mode. It defaults the socket to `0600` and accepts
`0660` only with an explicit dedicated group. It removes an existing socket
only after proving that it is a stale Unix stream socket, and removes its own
socket on shutdown.

## API v1

### Register

`POST /v1/registrations`

```json
{
  "app_path": "media",
  "upstream": "http://127.0.0.1:7342",
  "routes": ["/mcp", "/api/v1", "/birdz"],
  "health": "/birdz",
  "edge_auth": "key",
  "expected_tenant": "tenant-a",
  "lease_seconds": 30
}
```

The response is `201 Created` and contains an opaque `lease_id`, `source` set
to `aviarymcp`, and `expires_at`. The lease id is local control-plane state and
is not part of the cloud protocol. Treat it as a bearer capability within the
socket's trust boundary. The default lease is 30 seconds; accepted values are
10 through 300 seconds.

Routes are path-segment prefixes: `/api/v1` matches `/api/v1` and
`/api/v1/...`, but not `/api/v10`. `/` and wildcard routes are rejected. This
is a safer replacement for `forward_all` for SDK-managed applications.
`edge_auth` is `key` by default or `public` only when separately approved.
`expected_tenant` is optional; when set it must match the approving tenant.
After a scoped credential is loaded, status publishes its non-secret `tenant`
so the SDK can pin future caller-assertion verification. Public registrations
omit `expected_tenant`.

The scoped credential durably records the approved service/app path, routes,
edge-auth mode, approving tenant, and manifest digest. After a daemon restart, a registration is
relayed only when those fields match exactly. Widening, narrowing, or changing
public/key access reports `needs_enrollment` and never dials the hub with the
old grant. In the v1 pilot, a legitimate manifest change may require releasing
the existing service or choosing a new app path before a new approval can win;
the agent never silently broadens an incumbent grant.

### Renew and remove

* `PUT /v1/registrations/{lease_id}/renew` renews using the lease's original
  duration and returns the new `expires_at`.
* `DELETE /v1/registrations/{lease_id}` immediately withdraws it and returns
  `204 No Content`.

Renewal is deliberately separate from registration. Re-registering the same
`app_path` is a collision, which prevents two processes from silently taking
over one public service.

### Status

`GET /v1/services` returns both configuration sources:

```json
{
  "services": [
    {"app_path":"printer","upstream":"http://127.0.0.1:8000","source":"finch.yml","state":"configured"},
    {"app_path":"media","upstream":"http://127.0.0.1:7342","source":"aviarymcp","state":"registered","lease_id":"...","expires_at":"..."}
  ]
}
```

Runtime states include `registered`, `starting`, `assigned`, `live`,
`reconnecting`, `needs_enrollment`, and `error`. `live` is emitted only after
the relay WebSocket handshake succeeds. CLI `finch status --json` reads the
same combined status from a running agent when the socket is reachable.

## Collision and failure rules

* A dynamic `app_path` that exists in `finch.yml` fails with HTTP `409` and
  code `app_path_conflict`; neither source wins.
* A second dynamic registration for an unexpired `app_path` also fails `409`.
* An expired lease no longer collides and may be registered again.
* Invalid upstreams, unsafe routes, and invalid lease durations fail `400`.
* Changing `finch.yml` to introduce a collision must fail that reload and leave
  the last good effective configuration running. It must not evict a live app.
* Finch must never persist dynamic registrations into `finch.yml`.

## Implemented pilot sequence

1. Registry and handler contract plus SDK
   client against `httptest`/Unix-socket integration tests.
2. Add a Unix listener with strict ownership/mode checks and graceful shutdown.
3. Refactor config execution into a supervisor that reconciles a combined
   static-plus-leased desired-state map. Start/stop each service with the
   context-aware `Embed` path; do not modify relay frames or worker behavior.
4. Add route-prefix allowlists to local forwarding, retaining `/mcp` as the
   legacy default and `forward_all` only for YAML compatibility.
5. Enrollment reconciliation reuses existing scoped credentials; missing or
   revoked credentials remain in `needs_enrollment` without a cloud retry loop,
   and the scoped device flow wakes the relay after atomic grant persistence.
6. `finch status` reads the combined registry snapshot.

Config watching/reload remains future work and must preserve collision safety.

## Required integration tests before activation

* Socket is Unix-only, has the requested mode, and is removed on clean exit.
* Group-readable mode is tested and documented as one full control-plane trust
  boundary; tests must not imply per-app isolation within a shared group.
* YAML/dynamic and dynamic/dynamic collisions fail without disrupting the
  incumbent relay.
* Lease renewal races with expiry deterministically; expiry cancels exactly one
  relay and permits a new owner.
* `finchd` restart drops leases; an SDK client re-registers and resumes.
* Route matching rejects sibling prefixes, traversal, absolute URLs, and host
  injection while allowing declared subpaths.
* A malformed registration cannot crash or mutate other services.
* Missing enrollment reports `needs_enrollment`; it never loops cloud calls.
* Static YAML services continue operating when the control socket is unused.
