import type { MetadataRoute } from 'next';
import { SITE, SITEMAP_PATHS } from './site-paths';

export default function sitemap(): MetadataRoute.Sitemap {
  return SITEMAP_PATHS.map((path) => ({
    url: `${SITE}${path === '/' ? '' : path}`,
    changeFrequency: path === '/' ? 'weekly' : 'monthly',
    priority: path === '/' ? 1 : path === '/docs' ? 0.8 : 0.6,
  }));
}
