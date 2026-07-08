import Link from 'next/link';

function Code({ children }: { children: string }) {
  return <pre className="docs-code"><code dangerouslySetInnerHTML={{ __html: children }} /></pre>;
}

export default function Acls() {
  return (
    <>
      <h1>Access control</h1>
      <p className="docs-lede">
        Access rules decide who can reach what. Every rule is enforced at the hub,
        before a request ever touches your box. The policy is default-deny: no
        matching allow rule means the request is denied. You manage rules on the
        dashboard&apos;s Access page (admin only).
      </p>

      <h2>How a request is checked</h2>
      <p>
        A caller presents a <code>finch_</code> key (see{' '}
        <Link href="/docs/auth">Keys &amp; auth</Link>). Two gates must both pass:
      </p>
      <ol>
        <li>
          <b>Key scope.</b> The key must be scoped to all services or explicitly
          list the target service. This is the coarse per-key gate.
        </li>
        <li>
          <b>Access rules.</b> At least one allow rule must match: its source must
          match the key&apos;s identity, and its destination must match the target
          service. No match means a 403, and the request never reaches your box.
        </li>
      </ol>
      <p>
        A key&apos;s identity for rule matching is the key itself (by label or id),
        the user who owns it, and any groups that user or key belongs to.
      </p>
      <p>
        One exception: a service whose auth is set to <b>public</b> skips both
        gates. It needs no key at all, so access rules do not apply to it.
      </p>

      <h2>Rules: source may reach destinations</h2>
      <p>
        A rule grants one <b>source</b> access to one or more <b>destinations</b>.
        You build rules in the dashboard as &quot;source may reach destinations&quot;.
      </p>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Side</th><th>Types</th><th>Matches</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Source</td>
              <td><code>user</code>, <code>group</code>, <code>key</code></td>
              <td>The identity presenting the key: a specific key, a user (covers every key that user owns), or a group.</td>
            </tr>
            <tr>
              <td>Destination</td>
              <td><code>service</code>, <code>tag</code>, <code>group</code>, <code>all</code></td>
              <td>The target: one service by id, every service carrying a tag, every service in a group, or everything.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        The dashboard&apos;s rule builder offers <code>tag</code> and{' '}
        <code>group</code> destinations. <code>service</code> and{' '}
        <code>all</code> exist in the rule model (the seeded owner rule uses{' '}
        <code>all</code>) but are not choices in the builder.
      </p>
      <p>
        Tags are the practical unit. Tag your services on the Services page, then
        grant by tag: a rule like <code>key:crawler</code> may reach{' '}
        <code>tag:scraping</code> keeps working as you add and remove services,
        with no rule edits.
      </p>

      <h2>The owner rule</h2>
      <p>
        Every tenant is seeded with one locked rule: the owner may reach all
        services. It shows in the rule list as <code>admin · locked</code> and
        cannot be removed, so the owner can never lock themselves out. Everyone
        else is denied until you add an explicit allow rule.
      </p>

      <h2>The generated policy</h2>
      <p>
        The Access page has a Raw policy tab showing <code>policy.json</code>,
        generated from your rules. It is the source of truth at the door: what you
        see there is exactly what the hub enforces.
      </p>
      <Code>{`{
  "tagOwners": { "tag:scraping": ["you@finch"] },
  "acls": [
    { "action": "accept", "src": ["you@finch"], "dst": ["*"] },
    { "action": "accept", "src": ["key:crawler"], "dst": ["tag:scraping"] }
  ]
}`}</Code>

      <h2>One key per agent</h2>
      <p>
        The common setup: you run several MCP services and several agents, and
        each agent should reach only some of them. Mint one key per agent, scope
        it to the services that agent needs, and add a rule for it.
      </p>
      <Code>{`<span class="c"># a key for the research agent, scoped to one service</span>
finch keys mint research-agent --service scraper

<span class="c"># revoke it later; access stops immediately</span>
finch keys revoke &lt;id&gt;`}</Code>
      <p>
        Then in the dashboard, grant <code>key:research-agent</code> access to the
        tag (or group) it should reach. Different users and agents get different
        views of your fleet, and revoking one key cuts off exactly one caller.
      </p>
      <div className="docs-note">
        <b>Scope is a floor, not a grant.</b> A key scoped to a service still needs
        a matching allow rule. The owner&apos;s locked rule is why keys you mint for
        yourself work out of the box: they match as <code>user: you</code>.
      </div>

      <h2>Users &amp; roles</h2>
      <p>
        The dashboard&apos;s Users page (admin) lists everyone in your tenant.
        Invite a teammate by email; they get an email to join. Roles decide who
        can administer: who can approve boxes, edit access rules, and manage keys.
      </p>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr><th>Role</th><th>Can do</th></tr>
          </thead>
          <tbody>
            <tr><td>Owner</td><td>Everything. Cannot be removed or demoted.</td></tr>
            <tr><td>Admin</td><td>Administer the tenant: boxes, access rules, keys, users.</td></tr>
            <tr><td>Member</td><td>Use the services they have been granted access to.</td></tr>
          </tbody>
        </table>
      </div>
      <p>
        Users appear as rule sources, so &quot;user may reach tag&quot; is how you
        give a teammate access to a slice of your fleet.
      </p>

      <div className="docs-foot">
        <Link href="/docs/auth">← Keys &amp; auth</Link>
        <Link href="/docs/domains">Domains →</Link>
      </div>
    </>
  );
}
