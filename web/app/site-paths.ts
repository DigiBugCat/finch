// The site's public pages, for sitemap.ts and robots.ts. Kept out of those
// two files because Next treats them as route modules.

export const SITE = 'https://finchmcp.com';

// Every public page a search engine should know about. Sign-in, sign-up and
// the /cli approval page are left out on purpose (robots.ts disallows them).
// web/test/site-basics.test.tsx fails when a docs page is missing from here,
// and when a docs path listed here has no page. The landing links to "Host it
// yourself" only once '/docs/self-host' is listed, so add it with that page.
export const SITEMAP_PATHS = [
  '/',
  '/docs',
  '/docs/services',
  '/docs/auth',
  '/docs/acls',
  '/docs/domains',
  '/docs/cli',
  '/docs/privacy',
  '/docs/self-host',
  '/docs/aviarymcp',
  '/agents.md',
  '/llms.txt',
] as const;
