import type { ReactNode } from 'react';

/** A plate's header: eyebrow + title, with an optional lede set beside it. */
export default function PlateHead({
  id,
  plate,
  title,
  lede,
}: {
  id: string;
  plate: string;
  title: string;
  lede?: ReactNode;
}) {
  return (
    <div className={lede ? 'fg-head fg-head-split' : 'fg-head'}>
      <div className="fg-head-title">
        <span className="iw-label iw-label-indigo">{plate}</span>
        <h2 id={id}>{title}</h2>
      </div>
      {lede ? <p className="fg-lede">{lede}</p> : null}
    </div>
  );
}
