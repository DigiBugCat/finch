// Copy the landing shows and copies. These strings are part of the shared CLI
// contract (the landing, /agents.md and the agent must all match), so they
// live in one place and web/test/fieldguide-landing.test.tsx pins them.

/** The one paste for humans: hand this to an agent and it does the rest. */
export const AGENT_PROMPT =
  'Read https://finchmcp.com/agents.md and use finch to publish my MCP server on http://127.0.0.1:8000 as notes. Show me the sign-in link when you get it. Run it as a background service, check it with finch test, then connect it to this agent.';

// Explicit https:// — a scheme-less host makes curl default to http://, which
// would pipe an unauthenticated cleartext response into sh.
export const INSTALL_ONE_LINER = 'curl -fsSL https://finchmcp.com/install | sh';

/** The same setup, typed by hand. */
export const MANUAL_STEPS = [
  INSTALL_ONE_LINER,
  'finch login',
  'finch add notes --service http://127.0.0.1:8000',
  'finch service install',
] as const;

/** The account address the examples use. Real ones look like this: finch
 *  picks a word, a bird and a number for each account. */
export const EXAMPLE_SLUG = 'sunny-wren-42';
export const EXAMPLE_URL = `https://${EXAMPLE_SLUG}.finchmcp.com/notes/mcp`;
