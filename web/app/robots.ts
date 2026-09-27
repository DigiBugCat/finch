import type { MetadataRoute } from 'next';
import { SITE } from './site-paths';

// Crawl the landing and the docs; skip the pages that only make sense signed
// in (the /cli login approval), the auth pages and the API routes.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/cli', '/sign-in', '/sign-up', '/api/', '/dashboard'] }],
    sitemap: `${SITE}/sitemap.xml`,
  };
}
