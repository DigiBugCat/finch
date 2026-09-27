// The finch silhouette every plate reuses: a painted body path and a round
// head, drawn in a -28 -26 50 30 box with the feet at the origin.
import type { CSSProperties } from 'react';

export const BIRD_BODY =
  'M-12 -8 C -10 -20, 8 -22, 12 -12 C 14 -6, 8 0, 0 0 L -8 0 C -14 0, -20 -2, -26 2 C -22 -4, -16 -6, -12 -8Z';
export const BIRD_VIEWBOX = '-28 -26 50 30';

/** The bird's two shapes, for use inside a <g> that sets fill/transform. */
export function BirdShape() {
  return (
    <>
      <path d={BIRD_BODY} />
      <circle cx="9" cy="-19" r="6" />
    </>
  );
}

type BirdProps = {
  fill: string;
  transform?: string;
  painted?: boolean;
  style?: CSSProperties;
};

/** A bird in one colour; `painted` gives it the gouache edge. */
export function Bird({ fill, transform, painted = false, style }: BirdProps) {
  return (
    <g transform={transform} filter={painted ? 'url(#iw-gouache)' : undefined} style={{ fill, ...style }}>
      <BirdShape />
    </g>
  );
}

/** The site mark: an indigo finch with an ochre beak. */
export function BirdMark({ width = 30, height = 24 }: { width?: number; height?: number }) {
  return (
    <svg width={width} height={height} viewBox={BIRD_VIEWBOX} aria-hidden="true" focusable="false">
      <Bird fill="var(--indigo)" painted />
      <path d="M14 -20 L20 -18 L14 -16Z" style={{ fill: 'var(--ochre)' }} />
    </svg>
  );
}
