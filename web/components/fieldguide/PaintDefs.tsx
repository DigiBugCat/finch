// The Indigo Wash paint filters, defined once per document (root layout) and
// referenced by id from every plate. Kept out of display:none: filters inside
// a display:none SVG do not apply in every browser.
export default function PaintDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        {/* iw-gouache: soft painted edge on opaque shapes (edge-displacement 3.5) */}
        <filter id="iw-gouache" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves={2} seed={2} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={3.5} xChannelSelector="R" yChannelSelector="G" />
        </filter>
        {/* iw-wash: watercolour edge on skies and far fields (wash-displacement 9) */}
        <filter id="iw-wash" x="-8%" y="-8%" width="116%" height="116%">
          <feTurbulence type="fractalNoise" baseFrequency="0.028" numOctaves={3} seed={4} result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={9} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    </svg>
  );
}
