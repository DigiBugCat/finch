import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

// Every surface that renders the pipe-to-shell install one-liner. llms.txt is
// served at https://finchmcp.com/llms.txt and is written to be executed by AI
// agents verbatim, so a bad string here is run without a human reading it.
const SURFACES = [
  'public/llms.txt',
  'app/docs/page.tsx',
  'components/HowItWorks.tsx',
];

describe('published install one-liner', () => {
  it('always pins an explicit https:// scheme', () => {
    for (const surface of SURFACES) {
      const source = read(surface);

      expect(source).toContain('curl -fsSL https://finchmcp.com/install | sh');
      // curl has no scheme-guessing safety net: given a bare host it defaults
      // to http://, so a scheme-less one-liner would fetch the installer in
      // cleartext from an unauthenticated origin and pipe it straight into sh.
      // Assert the negative too — adding an https:// copy elsewhere in the file
      // would not have caught a scheme-less variant left behind next to it.
      expect(source).not.toMatch(/curl [^\n]*(?<!:\/\/)\bfinchmcp\.com\/install/);
    }
  });
});
