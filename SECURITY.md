# Security policy

finch relays traffic to servers on people's own machines, so we treat security
reports as the most urgent kind of issue.

## Reporting a vulnerability

Please report it privately, not in a public issue:

1. Use GitHub private vulnerability reporting: open
   <https://github.com/DigiBugCat/finch/security/advisories/new>, or the
   repository's **Security** tab and choose **Report a vulnerability**. Only
   the maintainers can see what you send.
2. If that form is not available, open an issue titled "Private contact
   request" and leave the body empty. Do not say what it is about, which part
   of finch it concerns, or that it is a security report. A maintainer will
   reply with a private way to reach them.

Include what you found, the steps or request that show it, what an attacker
gains, and the finch version (`finch version`) or the URL involved. Do not
test against other people's services or accounts on finchmcp.com; use your
own account, or a hub you run yourself ([`docs/self-host.md`](docs/self-host.md)).

We aim to acknowledge a report within three working days and to tell you how
we plan to fix it within ten. We credit reporters in the release notes unless
you ask us not to.

## What is in scope

- The hub (`worker/`), including the relay, key and OAuth checks, and the CLI
  API.
- The website (`web/`): sign-in and the `finch login` approval page.
- The `finch` CLI and agent (`agent/`), and the installer served at `/install`.
- The hosted service at finchmcp.com and its subdomains.

Out of scope: denial of service by volume, findings that need an
already-compromised machine or Cloudflare account, the behaviour of your own
local server, and reports from automated scanners without a demonstrated
impact.

## Supported versions

| Component | Supported |
|---|---|
| `finch` CLI | The latest release. Fixes ship as a new release; `finch update` installs it. |
| Hub and website at finchmcp.com | Always the current deployment. |
| Self-hosted hubs | The latest release tag. Redeploy to pick up fixes. |

The design of each security boundary, and what finch can and cannot see, is in
[`docs/security-and-deploy.md`](docs/security-and-deploy.md) and
[`docs/privacy.md`](docs/privacy.md).
