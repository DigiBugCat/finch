import { readdirSync, readFileSync } from 'node:fs';
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
    // The landing's title, and a template for every other page ("Page not
    // found · finch"); the docs layout sets its own "· finch docs" template.
    expect(metadata.title).toEqual({ default: 'finch — localhost, with a front door', template: '%s · finch' });
    expect(metadata.description).toMatch(/^finch gives the MCP server on your Mac or Linux machine a stable https address/);
    expect(metadata.openGraph).toMatchObject({
      title: 'finch — localhost, with a front door',
      description: metadata.description,
      siteName: 'finch',
    });
    // No og:url pinned to the home page: every page inherits openGraph, and a
    // docs page must not claim to be the landing.
    expect(metadata.openGraph).not.toHaveProperty('url');
    // The share image is large, so ask for the large card.
    expect(metadata.twitter).toMatchObject({ card: 'summary_large_image' });
  });

  it('ships a real share image with alt text', () => {
    const png = readFileSync(resolve(root, 'app/opengraph-image.png'));
    expect(png.readUInt32BE(0)).toBe(0x89504e47); // PNG signature
    // 1200 x 630, the size every link preview expects.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(png.length).toBeLessThan(300 * 1024);
    expect(read('app/opengraph-image.alt.txt').trim()).toMatch(/^finch: /);
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

  it('self-hosts them: no runtime Google Fonts request, and the CSP allows none', () => {
    for (const file of ['app/layout.tsx', 'app/globals.css', 'components/fieldguide/landing.css', 'app/docs/docs.css', 'next.config.ts']) {
      expect(read(file)).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    }
    const csp = read('next.config.ts');
    expect(csp).toContain(`"style-src 'self' 'unsafe-inline'"`);
    expect(csp).toContain(`"font-src 'self' data:"`);
  });
});

describe('site icon', () => {
  it('declares each icon once: favicon.ico, the SVG and the iOS home-screen PNG', () => {
    expect(metadata.icons).toEqual({
      icon: [
        { url: '/favicon.ico', sizes: '48x48' },
        { url: '/icon.svg', type: 'image/svg+xml' },
      ],
      apple: [{ url: '/apple-touch-icon.png', sizes: '180x180' }],
    });
    expect(read('public/icon.svg')).toMatch(/<svg[\s>]/);
    // Next serves app/favicon.ico, app/icon.* and app/apple-icon.* on its own,
    // adding a second copy of each icon to every page's <head>.
    const conventional = readdirSync(resolve(root, 'app')).filter((f) => /^(favicon|icon|apple-icon)\./.test(f));
    expect(conventional).toEqual([]);
  });

  it('serves a real /favicon.ico (browsers ask for it whatever the page says)', () => {
    const ico = readFileSync(resolve(root, 'public/favicon.ico'));
    // ICONDIR: reserved 0, type 1 (icon), then the image count.
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const count = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      const size = ico.readUInt8(entry);
      const bytes = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      // Each image is a whole PNG inside the file.
      expect(offset + bytes).toBeLessThanOrEqual(ico.length);
      expect(ico.readUInt32BE(offset)).toBe(0x89504e47);
      expect(ico.readUInt32BE(offset + 16)).toBe(size);
      sizes.push(size);
    }
    expect(sizes).toEqual([16, 32, 48]);

    const apple = readFileSync(resolve(root, 'public/apple-touch-icon.png'));
    expect(apple.readUInt32BE(0)).toBe(0x89504e47);
    expect([apple.readUInt32BE(16), apple.readUInt32BE(20)]).toEqual([180, 180]);
  });
});
