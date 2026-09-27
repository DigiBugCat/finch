# Single-user migration (September 2026, historical)

> **Historical.** What the single-user migration (#47, shipped in finch 1.7.0) deletes now that every account is one tenant. The `v7` class deletion ran at deploy; each account's own purge runs lazily, the first time its `TenantDO` loads, so an account untouched since then still holds its legacy rows (see "A tenant no request touches" below). It shipped to production with finch 1.7.0 (#51) and is kept as the record of what was removed and why.

## What the migration did (owner-approved, destructive)

Deploying this version permanently deletes legacy data:

- **Durable Object migration `v7`** (`deleted_classes`) deletes
  `AviaryEnrollmentDO` (the retired device-enrollment records) and
  `DirectoryDO` (the global Clerk-user → tenant index) with all their stored
  data, in every environment. `deploy-preflight` (scripts/do-migrations.mjs)
  allows exactly this deletion and refuses any other `deleted_classes` step,
  and refuses any edit to the applied migration history.
- **TenantDO purge.** On the first request each TenantDO serves after the
  deploy, `purgeLegacyTenancy` runs once, recorded by the versioned
  `singleUserPurge` flag in the stored state (tenants created afterwards are
  born flagged; bump `SINGLE_USER_PURGE_VERSION` to run a new pass). The
  owner is the member row whose `clerkUserId` is the tenant id; a team
  workspace or Clerk-org tenant (`kind: "team"` or an `org_` id) has no owner.
  The purge:
  - deletes every other member row (co-owners, admins, members,
    invitations) and normalizes the owner's row to an active owner; with no
    owner it also deletes `tenantMeta`, so the tenant's own user bootstraps
    it afresh;
  - deletes `groups`, `acl`, `accessRequests`, `sessionEpoch`, the earlier
    `cliSingleUserCut` flag, the Aviary fields on services
    (`aviaryManaged`, `aviaryManifestSha256`, `aviaryApprovalNonce`, and the
    manifest's `routes`) and boxes (`aviaryCredentialEpoch`,
    `aviaryPendingCredentialEpoch`, `aviaryPendingApprovalNonce`);
  - deletes `access` audit rows and any audit row naming a non-owner member;
  - decides whether the tenant was **exposed**: anyone besides the owner
    could have signed in to it. That is a team/org tenant, or any other
    member row that is not a never-accepted invitation (`state: "invited"`
    with no `clerkUserId`/`boundAt`). A removed member who had signed in was
    kept as a `disabled` row, so the rows are a complete record.
  - **exposed:** revokes every `finch_` key, removes every box, and bumps
    `cliTokenEpoch` once. Stored state never records who minted a key or
    enrolled a box. A key's `owner` is only who it was labelled for; the
    Keys view defaulted it to the tenant owner, and a CLI mint always used
    the owner's email, so an admin's key can carry the owner's label.
    Removing a box is what makes `/refresh` refuse its long-lived `/join`
    credential (those carry no epoch) and stops the relay routing to it,
    pinned paths included. Marking boxes `pending` would not be enough: a
    pinned path still reaches a pending box, and `finch approve` clears a
    whole service at once. Services stay. Each one emptied here is listed in
    `reenroll`, so the owner's next `finch add <name>` (the command a revoked
    box's agent prints) re-enrolls it in place at the same URL, once,
    instead of creating `<name>-2`.
  - **not exposed:** revokes only keys labelled with an email other than
    the owner's (a key labelled with the owner's email or the `"you"`
    placeholder stays). Boxes and CLI logins are untouched, so never-accepted
    invitations cost the owner nothing.
  - removes revoked key ids from service and box key lists.
  - **ownerless tenants** (team/Clerk-org) also get every service set to
    `auth: "key"`, so with no key and no box nothing on them answers. If
    exactly one active owner row with a Clerk id existed, that user is
    recorded as `routeHeir`, and `handOffRoutes` moves every RouterDO host
    key the tenant holds (its finchmcp.com slugs and custom hostnames) to
    that user's tenant. Before this change, the tenant chooser sent that user
    to the team tenant. Each key moves atomically (`RouterDO.transfer`), so
    it is never claimable in between. Cloudflare custom hostnames are keyed
    by hostname, so they need no change. The marker is cleared only when
    every key has moved, and a router failure is retried by the next
    instance. With no single former owner, the hosts stay with the inert
    tenant, since slugs are never recycled.

  Because the purge is lazy, a sleeping team tenant could still hold a slug
  or hostname its former owner tries to claim. On a collision,
  `routerRegisterWakingHolder` (used by the subdomain setting and
  `POST /api/hostnames`) wakes the holder once, which runs its purge and
  hand-off, and then re-checks. `POST /api/hostnames` never provisions a
  hostname at Cloudflare again when the tenant already owns it (for
  example, after a hand-off). A duplicate would fail, and its failure path
  would unregister the hostname.

  A tenant with only its owner changes nothing but the flag (plus dropping
  the always-present `acl`/`groups` defaults). A tenant no request touches
  keeps its legacy rows until one does. After `v7` there is no index of such
  tenants. RouterDO's `slugs` table still lists every tenant that holds a hub
  domain, which covers every tenant that ever loaded state or enrolled a
  service, and that is the source a later sweep would use.

`SESSION_SECRET` (hub) and `CLERK_WEBHOOK_SECRET` (web) are no longer read;
either can be deleted as a separate step. The Clerk production webhook
endpoint, whose web route was removed with the CLI cut, should be removed
from the Clerk dashboard.
