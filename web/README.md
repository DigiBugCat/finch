# finch web (`web/`)

The browser side of Finch, which is otherwise driven entirely from the `finch`
CLI: the landing page, the docs, Clerk sign-in/sign-up, and the `finch login`
approval page. Next.js (App Router) deployed to **Cloudflare Workers via
[OpenNext](https://opennext.js.org/cloudflare)** — **not** Vercel.

> **Node 22 required.** The OpenNext build silently breaks on Node 26 (see
> [`.nvmrc`](.nvmrc) / `engines`). Run `nvm use` / `fnm use` before building.

## What's in it

| Surface | What |
|---|---|
| **Landing** (`/`) | "finch, a field guide": seven illustrated plates in the Indigo Wash design system (`components/fieldguide/`). SVG + CSS/SMIL animation, final frames under `prefers-reduced-motion`; fonts self-hosted via `next/font`. |
| **Docs** (`/docs/*`) | Quickstart, services and boxes, keys and auth, access control, domains, the CLI reference, privacy. Also `/llms.txt` for agents. |
| **Sign-in / sign-up** | Clerk. Lands on `/docs` unless a `redirect_url` (such as a `/cli` link) says otherwise. |
| **CLI approval** (`/cli`) | `finch login` prints a link + code; the signed-in owner confirms the code here and the hub mints the box's CLI token. |

```
 browser ──▶ /cli ──▶ /api/finch/cli-describe, /api/finch/cli-approve (BFF route handlers)
                          │  Clerk auth() → resolveTenant (the owner's tenant)
                          │  sign a short-lived {tenant} assertion
                          ▼
                     finch hub Worker  (verifies X-Finch-Service
                                        + the signed X-Finch-Auth)
```

The BFF never exposes the hub directly: each route checks the Clerk session,
resolves the caller to one tenant, confirms they are its active owner with
`/api/member-context`, then calls the hub over the `FINCH_HUB` service binding with the shared
`FINCH_SERVICE_SECRET` **and** an HMAC-signed tenant assertion (so a leaked
secret alone can't act as an arbitrary tenant).

Which tenant: the personal one (the Clerk user id) unless the hub's
user-scoped `/api/user/sync` lists other tenants the user actively owns. Then
the web probes each candidate's `/api/state` and picks the one holding services
or keys; if none does it stays personal, and if more than one does it refuses
(409) rather than strand the others, since there is no workspace switcher.
The `/cli` page shows the chosen account before the user approves.

Everything else a user does (services, keys, domains, revoking CLI tokens)
is a `finch` CLI command talking to the hub's `/api/cli/*` directly, not
this app.

## Privacy behavior

Ordinary calls travel over HTTPS from the client and WSS from the Finch hub to
the outbound box agent. Cloudflare terminates those encrypted connections, so
this is transport encryption, not end-to-end encryption. Finch processes the
payload transiently to relay it, but its application storage and logs do not
retain ordinary request or response bodies. The full data-handling boundary is
documented in [`../docs/privacy.md`](../docs/privacy.md).

## Setup

```bash
cp .dev.vars.example .dev.vars
```

Fill `.dev.vars`:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` — from a Clerk dev instance.
- `HUB_URL` — the finch hub (e.g. `http://localhost:8787` in dev).
- `FINCH_SERVICE_SECRET` — **must match `worker/.dev.vars`** (the web signs
  assertions the hub verifies).

```bash
npm install
npm run dev          # http://localhost:3000  (run the hub in worker/ first)
```

## Scripts

| Script | What |
|---|---|
| `npm run dev` | local dev server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | eslint |
| `npm test` | vitest (BFF auth, the signAssertion↔hub contract, the hub transport, …) |
| `npm run build` | `next build` |
| `npm run deploy` | OpenNext build + deploy to Cloudflare |

## Layout

| Path | What |
|---|---|
| `app/cli`, `components/CliApprove.tsx` | the `finch login` approval page |
| `app/api/finch/*` | BFF route handlers for it — Clerk-gated, sign + proxy to the hub |
| `app/docs/*` | the docs |
| `lib/hub.ts` | hub client: `resolveTenant`, `requireAdmin`, `hubFetchAs`, error shaping |
| `lib/assertion.ts` | the Clerk-free HMAC signer (shared shape with `worker/src/auth.ts`) |
| `middleware.ts` | Clerk middleware + CSRF (`Sec-Fetch-Site`/`Origin`) checks |
| `test/` | vitest unit/contract tests |

> Heads-up: this repo pins a **non-standard Next.js** build (see
> [`AGENTS.md`](AGENTS.md)) — check the installed package before changing
> framework-level code.
