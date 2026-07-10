# Finch caller assertions

Finch can pass an authenticated caller identity to a hosted AviaryMCP service
without forwarding the caller's credential. After the Worker accepts a Finch
key, Clerk OAuth token, browser login-wall session, or first-party service
assertion, it signs a 60-second ES256 compact JWS. The JWS travels in the
dedicated Worker-to-agent `req.assertion` field. The agent removes every
reserved caller-identity header and sets `X-Finch-Assertion` from that field
only.

Public services do not receive an assertion. An open edge route must not be
mistaken for an authenticated principal.

## Claims

The payload contains:

- `iss`: stable Finch issuer configured for the environment.
- `sub`: `key:<id>`, `user:<id>`, or `service:finch-dashboard`.
- `tenant`, `service`, and `aud` (`finch:<tenant>:<service>`).
- `auth_method`: `finch_key`, `oauth`, `browser`, or `service`.
- `method`, `upstream_path` (the exact local path plus query), and
  `public_path` (the normalized path at the edge).
- `body_sha256`: base64url SHA-256 of the raw request body.
- `iat`, `nbf`, `exp`, and random `jti` for a short replay window.
- `session_id`, key metadata, and actor where that auth path provides them.

An application must verify ES256, select a known `kid`, validate issuer,
audience, tenant, service, expiry/clock skew, method, upstream path, body digest,
and reject replayed `jti` values for the assertion lifetime. It must never trust
unsigned `X-Finch-User`, `X-Finch-Tenant`, or similar headers.

## Worker configuration

Each environment needs all three settings before assertions are enabled:

- `FINCH_ASSERTION_ACTIVE_KID`: non-secret key identifier in Wrangler vars.
- `FINCH_ASSERTION_PRIVATE_JWKS`: Worker secret containing a private EC P-256
  JWKS (`{"keys":[...]}`).
- `FINCH_ASSERTION_ISSUER`: stable issuer URL in Wrangler vars.

Generate a key without writing it to disk:

```sh
cd worker
node scripts/generate-assertion-jwks.mjs finch-prod-2026-07 \
  | node scripts/validate-assertion-jwks.mjs finch-prod-2026-07 --passthrough \
  | npx wrangler secret put FINCH_ASSERTION_PRIVATE_JWKS --env production
```

The validator imports the active private key, performs an ES256 sign/verify,
and imports every public rotation key before passing the exact secret bytes to
Wrangler. It writes only a key count and public `kid` to stderr; key material is
never logged. Cloudflare does not expose an existing Worker secret value, so
this upload-time check is the only possible local validation of that value.

The production issuer and canonical public set are
`https://jwks.finchmcp.com` and
`https://jwks.finchmcp.com/.well-known/finch-jwks.json`. The dedicated hostname
avoids the Finch web application's apex route. The handler is also reachable on
tenant Worker hosts, but applications should use the canonical configured URL.
Private `d` material is never returned.

The route is not sufficient by itself: `jwks.finchmcp.com` must have a proxied
Cloudflare DNS record (the zone wildcard may satisfy this) and an active TLS
certificate. After production deploy, run:

```sh
npm run smoke:assertions
```

The JWKS handler first signs an internal fixed-scope token with the deployed
active private key and verifies it against the exact emitted public JWKS. That
successful result is cached per isolate/config; neither the token nor private
material is returned. The smoke probe performs a real HTTPS fetch, requires
that self-test to succeed, checks the expected active `kid`, and rejects an
empty set or any public key containing private `d` material. The deployment
workflow runs this probe immediately after both staging and production deploys.

An authenticated relay smoke additionally requires a live enrolled box,
service, and short-lived caller credential. Keep that stateful probe in the
pilot deployment/rollback runbook rather than CI: CI must not mint production
keys or mutate tenant/box state merely to validate a Worker deploy.

## Canonical request binding

AviaryMCP's signed surface is intentionally JSON over normalized MCP-safe HTTP
paths:

- REST and MCP bodies must be valid UTF-8 JSON. The current relay request frame
  carries a string, so it does not promise byte preservation for arbitrary
  binary or content-encoded bodies. Valid UTF-8 is decoded and re-encoded to
  the same bytes, which keeps `body_sha256` exact for AviaryMCP requests.
- Aviary tool and API path segments must use unreserved ASCII names (letters,
  digits, `_`, `-`, `.`, and `~`). Percent-escaped or non-ASCII path segments
  are outside the assertion contract until the Go relay carries a canonical
  escaped path explicitly. Percent-encoding in the query string is preserved.
- Apps that need binary uploads or escaped path segments should expose a
  separate route without Finch assertion enforcement, or upgrade the relay
  frame to a base64 body plus explicit raw/canonical path before relying on the
  binding.

The Worker continues to relay legacy protocol-agnostic HTTP services; these
constraints apply specifically to services that enforce `X-Finch-Assertion`.

## Rotation

1. Add the new private JWK alongside the old key in the secret and deploy.
2. Wait at least the JWKS cache lifetime (five minutes).
3. Change `FINCH_ASSERTION_ACTIVE_KID` to the new `kid` and deploy.
4. Keep the retired public/private entry for at least five minutes plus the
   60-second assertion TTL, then remove it.

The Worker caches imported signing keys per isolate; changing the JWKS text or
active `kid` invalidates that cache.

## Backward compatibility and rollout

When both assertion-signing settings are absent, relay behavior is unchanged
and no `req.assertion` field is emitted. This supports an agent-first rollout.
A partial or malformed configuration fails authenticated relays with JSON 503;
it never silently downgrades to an unsigned identity. Existing `finch.yml`,
public services, control APIs, connect tokens, and Finch key authentication are
otherwise unchanged.

Roll out in this order: assertion-aware agent, assertion-verifying AviaryMCP,
Worker key/JWKS configuration, then policy enforcement in AviaryMCP.
