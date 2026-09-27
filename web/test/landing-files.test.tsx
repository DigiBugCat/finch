// The landing's call to action copies a prompt that starts "Read
// https://finchmcp.com/agents.md", and its footer links to /agents.md. Those
// files live in web/public; agents.md is written by the CLI track. The deploy
// preflight refuses a staging/production deploy until they exist, so the
// landing can never ship pointing an agent at a 404.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import Home from '@/app/page';
import { AGENT_PROMPT } from '@/components/fieldguide/prompt';
import { LANDING_STATIC_FILES, missingLandingFiles } from '@/scripts/landing-files.mjs';

const webRoot = resolve(import.meta.dirname, '..');
const temps: string[] = [];
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'finch-landing-'));
  temps.push(d);
  return d;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('landing static files', () => {
  it('reports absent, empty and non-file entries as missing', () => {
    const dir = tempDir();
    expect(missingLandingFiles(dir)).toEqual(['agents.md', 'llms.txt']);

    writeFileSync(join(dir, 'agents.md'), '');
    mkdirSync(join(dir, 'llms.txt'));
    expect(missingLandingFiles(dir)).toEqual(['agents.md', 'llms.txt']);

    writeFileSync(join(dir, 'agents.md'), '# finch for agents\n');
    expect(missingLandingFiles(dir)).toEqual(['llms.txt']);
  });

  it('covers every same-site file the landing links to or tells an agent to read', () => {
    const { container } = render(<Home />);
    const linked = [...container.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href')!)
      .filter((h) => /^\/[^/?#]+\.[a-z]+$/.test(h))
      .map((h) => h.slice(1));
    const prompted = [...AGENT_PROMPT.matchAll(/https:\/\/finchmcp\.com\/([^\s/?#]+\.[a-z]+)\b/g)].map((m) => m[1]);

    // Not vacuous: the prompt and the footer really do point at agents.md.
    expect(prompted).toEqual(['agents.md']);
    expect(linked).toContain('agents.md');
    for (const f of [...linked, ...prompted]) expect(LANDING_STATIC_FILES).toContain(f);
  });
});

describe('deploy preflight waits for the landing files', () => {
  // A self-contained copy of the web root: the preflight resolves everything
  // relative to its own scripts/ folder, so this runs the real script against
  // a public/ we control.
  function stage(files: Record<string, string>) {
    const root = tempDir();
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'public'));
    for (const f of ['scripts/deploy-preflight.mjs', 'scripts/jsonc.mjs', 'scripts/landing-files.mjs', 'wrangler.jsonc', '.dev.vars.example']) {
      copyFileSync(join(webRoot, f), join(root, f));
    }
    for (const [name, body] of Object.entries(files)) writeFileSync(join(root, 'public', name), body);
    return root;
  }
  function preflight(root: string, env: string) {
    const clean = { ...process.env };
    delete clean.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete clean.CLERK_SECRET_KEY;
    return spawnSync(process.execPath, [join(root, 'scripts/deploy-preflight.mjs'), env], { env: clean, encoding: 'utf8' });
  }

  it('refuses staging and production while agents.md is missing', () => {
    const root = stage({ 'llms.txt': 'finch\n' });
    for (const env of ['staging', 'production']) {
      const r = preflight(root, env);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('/agents.md');
    }
  });

  it('passes once every landing file is there, and never gates local dev', () => {
    const ready = stage({ 'llms.txt': 'finch\n', 'agents.md': '# finch for agents\n' });
    for (const env of ['staging', 'production']) {
      const r = preflight(ready, env);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
    }
    expect(preflight(stage({}), 'dev').status).toBe(0);
  });
});
