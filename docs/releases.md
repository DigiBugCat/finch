# Releases and environments

Status: **current.** How code reaches staging and production, and how agent
binaries are released. Self-hosting? The lanes below are this repository's
own; [`self-host.md`](self-host.md) covers deploying your own copy.

finch has three deliberately separate lanes:

| Source | Destination | Trigger |
| --- | --- | --- |
| pull request | CI only | Every PR |
| `main` | staging (`finch-staging`, `finch-web-staging`) | Successful CI push |
| `production` | production (`finch-prod`, `finch-web-prod`) | Successful CI push; Environment approval when supported |

Version tags remain the trigger for `.github/workflows/release.yml`, which
builds and publishes finch **agent binaries only**. A tag never deploys the hub
or dashboard; `.github/workflows/deploy.yml` accepts only successful CI runs
whose source branch is exactly `main` or `production`.

The deployment workflow never reacts directly to a push. CI first tests the
hub, web, and agent and emits a small `release-candidate` artifact containing
the tested commit and branch. Deployment starts from the successful CI run,
checks that artifact, and checks out its exact SHA. This prevents a deployment
from racing CI or accidentally checking out a newer default-branch commit.

## Repository setup

In GitHub, configure these controls once:

1. Create `staging` and `production` Environments. Put each environment's
   existing `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and
   `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in that environment; do not share the
   staging and production credentials.
2. Restrict the `production` Environment to the `production` branch. If the
   repository plan supports Environment reviewers, require one and prevent
   self-review when the team size permits. Otherwise the protected production
   branch is the approval gate.
3. Protect `main` and `production`. Require pull requests and the `versions`,
   `worker`, `web`, and `agent` CI checks; disallow force pushes and branch
   deletion. Require at least two approvals for `production` if the team size
   permits. (`release-candidate` intentionally runs only after branch pushes,
   so it must not be a pull-request required check.)
4. Keep Cloudflare runtime secrets in their existing per-environment Worker
   secret stores. GitHub Actions deploys code/configuration and does not copy
   runtime secrets between environments.

GitHub environment protection is configured in repository settings, not in a
workflow file. The YAML's `environment: production` label alone does **not**
create an approval gate. This repository currently restricts each Environment
to its matching branch and protects both branches; add an Environment reviewer
if the billing plan later enables it.

For the initial rollout, configure the protected `production` branch and
Environment first, then create `production` from the current `main`. The first
real promotion should be a reviewed `main` to `production` pull request.

## Promotion

Develop on a feature branch and merge to `main`. Once staging CI, deployment,
and smoke checks pass, promote the same tested history with a pull request from
`main` to `production`. Merging that PR runs CI again and deploys only after all
production checks pass; plans with Environment reviewers add a manual approval.
Do not commit directly to `production` or use tags as a deploy trigger.

Staging deployments are latest-wins: a newer successful `main` run cancels an
older in-progress staging release. Production deployments are serialized and
never auto-cancelled. The hub deploys first, then the web application, then a
public smoke check runs.

## Rollback

Rollback is another auditable promotion. Revert the bad promotion on the
`production` branch (or create a PR that restores the last known-good tree), let
CI pass, and approve that production deployment. This preserves branch history
and reuses every release gate. Record the last successful deployment SHA from
the Actions deployment summary before beginning the rollback.

If production is actively unavailable and the normal rollback path is too
slow, an operator may use Cloudflare's version rollback as an emergency action.
That is a break-glass procedure: record the selected Worker version, incident,
and operator, then immediately reconcile the `production` branch through the
normal PR path so Git and the deployed state agree again.

## Agent releases

The agent version lives in two places that must agree:
`agentVersion` in `agent/core/agent.go` and `LATEST_AGENT` in
`worker/src/types.ts` (the hub tells `finch update` which version is latest).
`node scripts/check-versions.mjs` checks them in CI.

To release:

1. In a normal pull request, bump both literals, and move the `Unreleased`
   entries in [`CHANGELOG.md`](../CHANGELOG.md) under the new version with
   today's date.
2. After it merges, tag the merge commit and push the tag:
   `git tag v1.8.0 && git push origin v1.8.0`.
3. `.github/workflows/release.yml` re-runs the version check against the tag
   (`check-versions.mjs --expected-tag`), race-tests the agent, and runs
   GoReleaser. GoReleaser builds `finch-<os>-<arch>` binaries for macOS and
   Linux (amd64, arm64, armv6, armv7) plus `checksums.txt`, and publishes a
   GitHub release whose notes start with the install line and group the
   commits since the previous tag.
4. The workflow mirrors the assets into the `finch-releases` R2 bucket, which
   the hub serves at `/releases/<asset>` for the installer and `finch update`.
5. Promote the hub to production (the `LATEST_AGENT` bump ships with it), so
   `finch update` on existing machines offers the new version.

A tag never deploys the hub or the web.
