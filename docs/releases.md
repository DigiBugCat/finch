# Release environments

Finch has three deliberately separate lanes:

| Source | Destination | Trigger |
| --- | --- | --- |
| pull request | CI only | Every PR |
| `main` | staging (`finch-staging`, `finch-web-staging`) | Successful CI push |
| `production` | production (`finch-prod`, `finch-web-prod`) | Successful CI push plus GitHub Environment approval |

Version tags remain the trigger for `.github/workflows/release.yml`, which
builds and publishes Finch **agent binaries only**. A tag never deploys the hub
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
2. On `production`, enable required reviewers, prevent self-review when the
   team size permits, and restrict deployment branches to `production`.
3. Protect `main` and `production`. Require pull requests and the `versions`,
   `worker`, `web`, and `agent` CI checks; disallow force pushes and branch
   deletion. Require at least two approvals for `production` if the team size
   permits. (`release-candidate` intentionally runs only after branch pushes,
   so it must not be a pull-request required check.)
4. Keep Cloudflare runtime secrets in their existing per-environment Worker
   secret stores. GitHub Actions deploys code/configuration and does not copy
   runtime secrets between environments.

GitHub environment protection is configured in repository settings, not in a
workflow file. Until the required reviewer and branch restriction are enabled,
the YAML's `environment: production` label alone does **not** create an approval
gate.

For the initial rollout, configure the protected `production` Environment
first, then create `production` from the current `main` after these workflows
are present on the default branch. Creating the branch can trigger CI and queue
a production approval; reject that run if this is only branch setup. The first
real promotion should still be a reviewed `main` to `production` pull request.

## Promotion

Develop on a feature branch and merge to `main`. Once staging CI, deployment,
and smoke checks pass, promote the same tested history with a pull request from
`main` to `production`. Merging that PR runs CI again; the production deployment
then pauses at the protected Environment for approval. Do not commit directly
to `production` and do not use tags as a production deployment trigger.

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
