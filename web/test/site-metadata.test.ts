import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// next/font only works inside the Next compiler; stand in for it with loaders
// that enforce the same option rules next/font/google does for these families,
// so a typo'd weight or a missing variable fails here rather than at build.
const registered: Record<string, string> = {};
const WEIGHTS: Record<string, string[] | 'variable'> = {
  Newsreader: 'variable',
  Manrope: 'variable',
  Kalam: ['300', '400', '700'],
  IBM_Plex_Mono: ['100', '200', '300', '400', '500', '600', '700'],
};
function loader(family: string) {
  return (opts: { subsets?: string[]; weight?: string | string[]; variable?: string; display?: string }) => {
    if (!opts || !opts.subsets?.includes('latin')) throw new Error(`${family}: latin subset required`);
    if (!opts.variable || !/^--font-[a-z-]+$/.test(opts.variable)) throw new Error(`${family}: bad variable ${opts.variable}`);
    if (opts.display !== 'swap') throw new Error(`${family}: display must be swap`);
    const allowed = WEIGHTS[family];
    const weights = opts.weight === undefined ? [] : ([] as string[]).concat(opts.weight);
    if (allowed !== 'variable' && weights.length === 0) throw new Error(`${family}: a static font needs weight`);
    for (const w of weights) {
      if (allowed === 'variable' || !allowed.includes(w)) throw new Error(`${family}: weight ${w} not available`);
    }
    registered[family] = opts.variable;
    return { className: `f-${family}`, variable: `v-${family}`, style: { fontFamily: family } };
  };
}
vi.mock('next/font/google', () => ({
  Newsreader: loader('Newsreader'),
  Manrope: loader('Manrope'),
  Kalam: loader('Kalam'),
  IBM_Plex_Mono: loader('IBM_Plex_Mono'),
}));
vi.mock('@clerk/nextjs', () => ({ ClerkProvider: ({ children }: { children: unknown }) => children }));

const { metadata } = await import('@/app/layout');
const root = resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('site metadata', () => {
  it('uses the field-guide title and description, for Open Graph too', () => {
    expect(metadata.title).toBe('finch — localhost, with a front door');
    expect(metadata.description).toMatch(/^finch gives the MCP server on your Mac or Linux machine a stable https address/);
    expect(metadata.openGraph).toMatchObject({
      title: 'finch — localhost, with a front door',
      description: metadata.description,
      url: 'https://finchmcp.com',
    });
  });
});

describe('fonts', () => {
  it('loads all four Indigo Wash families and globals.css consumes each variable', () => {
    expect(Object.keys(registered).sort()).toEqual(['IBM_Plex_Mono', 'Kalam', 'Manrope', 'Newsreader']);
    const css = read('app/globals.css');
    for (const variable of Object.values(registered)) {
      expect(css).toContain(`var(${variable},`);
    }
  });

  it('self-hosts them: no runtime Google Fonts request for the CSP to allow', () => {
    for (const file of ['app/layout.tsx', 'app/globals.css', 'components/fieldguide/landing.css', 'app/docs/docs.css']) {
      expect(read(file)).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    }
  });
});
