// Static files the landing sends people and their agents to.
//
// The landing's main call to action copies a prompt that starts "Read
// https://finchmcp.com/agents.md", and the footer links to /agents.md and
// /llms.txt. Those are plain files in web/public, and agents.md is written by
// the CLI track, not by the landing. If the web deploys without one of them,
// the agent's very first step is a 404. deploy-preflight.mjs refuses a
// staging or production deploy until every file here exists and is non-empty;
// web/test/landing-files.test.tsx checks that this list covers every such link
// the landing actually renders.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const LANDING_STATIC_FILES = ["agents.md", "llms.txt"];

/** The landing's static files that are absent (or empty) under publicDir. */
export function missingLandingFiles(publicDir, files = LANDING_STATIC_FILES) {
  return files.filter((f) => {
    const p = join(publicDir, f);
    return !existsSync(p) || !statSync(p).isFile() || statSync(p).size === 0;
  });
}
