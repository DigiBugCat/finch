import type { Metadata } from 'next';

/**
 * A docs page's metadata. `title` fills the docs layout's template
 * ("Keys & auth · finch docs"). Open Graph and Twitter don't inherit the page
 * title on their own, so without this a shared docs link would preview as the
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
    title,
    description,
    openGraph: { title: full, description, siteName: 'finch', type: 'article', images: [SHARE_IMAGE] },
    twitter: { card: 'summary_large_image', title: full, description, images: [SHARE_IMAGE] },
  };
}
