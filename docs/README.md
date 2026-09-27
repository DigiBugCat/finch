# finch docs

Documents for people working on finch or running their own. The user-facing
docs live on the website at [finchmcp.com/docs](https://finchmcp.com/docs)
(source in `web/app/docs/`), and the guide AI agents follow is
[`web/public/agents.md`](../web/public/agents.md).

## Current

| Document | What it covers |
|---|---|
| [`self-host.md`](self-host.md) | Deploying your own hub and website on Cloudflare, step by step. |
| [`self-host-coupling.md`](self-host-coupling.md) | Every place `finchmcp.com` is hard-coded, as a checklist of changes for a second domain. |
| [`security-and-deploy.md`](security-and-deploy.md) | How each hop is authenticated, what is deployed, and how environments are separated. |
| [`privacy.md`](privacy.md) | What finch can see, what it keeps, and the approved wording for both. |
| [`relay-protocol.md`](relay-protocol.md) | The wire format between the hub and the agent. |
| [`releases.md`](releases.md) | How code reaches staging and production, and how agent binaries are released. |
| [`../worker/CALLER_ASSERTIONS.md`](../worker/CALLER_ASSERTIONS.md) | The signed `X-Finch-Assertion` caller identity and key rotation. |

## Archive

Kept for the record. Each file starts with a note saying what it was.

| Document | What it was |
|---|---|
| [`archive/security-review-2026-06.md`](archive/security-review-2026-06.md) | The pre-launch security audit, with how each finding was resolved. |
| [`archive/code-review-2026-06.md`](archive/code-review-2026-06.md) | The pre-launch correctness review, including the removed dashboard. |
| [`archive/design-2026-06.md`](archive/design-2026-06.md) | Original design rationale, cost model and first roadmap. |
| [`archive/relay-protocol-v2-plan.md`](archive/relay-protocol-v2-plan.md) | The streaming relay plan, most of which shipped in a simpler form. |
| [`archive/single-user-migration.md`](archive/single-user-migration.md) | What the September 2026 single-user migration deleted. |
| [`archive/device-protocol.md`](archive/device-protocol.md) | A mailbox protocol for small devices. Not built. |
| [`archive/hostname-ownership-design.md`](archive/hostname-ownership-design.md) | Ownership checks for custom hostnames. Not built. |
