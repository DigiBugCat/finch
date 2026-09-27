import type { Metadata } from 'next';

/**
 * A docs page's metadata. The tab title, the Open Graph title and the Twitter
 * title are one string, "<Title> · finch docs", set as an absolute title. The
 * docs layout's "%s · finch docs" template can't do this for every page: Next
 * applies a layout's template only to pages in segments below it, so the
 * Quickstart (app/docs/page.tsx, the layout's own segment) would get the root
 * "%s · finch" template instead. Open Graph and Twitter don't inherit the page
 * title on their own, so without them a shared docs link would preview as the
 * landing page. Setting openGraph here replaces the image Next would add from
 * app/opengraph-image.png, so the same image is named again explicitly.
 */
const SHARE_IMAGE = {
  url: '/opengraph-image.png',
  width: 1200,
  height: 630,
  alt: 'finch: Localhost, with a front door.',
};

export function docsMetadata(title: string, description: string): Metadata {
  const full = `${title} · finch docs`;
  return {
    title: { absolute: full },
    description,
    openGraph: { title: full, description, siteName: 'finch', type: 'article', images: [SHARE_IMAGE] },
    twitter: { card: 'summary_large_image', title: full, description, images: [SHARE_IMAGE] },
  };
}
