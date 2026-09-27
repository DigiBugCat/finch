"use client";
// The instrument's clock: UTC time now, next to the time the page read the
// hub. The server renders the read time; the client ticks it forward once a
// second. The ticking digits are hidden from screen readers (a live clock
// would chatter); they get the read time once instead. The blinking dot stops
// under reduced motion (globals.css .iw-blink).
import { useEffect, useState } from 'react';
import { utcClock } from './model';

export default function FleetClock({ readAt }: { readAt: number }) {
  const [now, setNow] = useState(readAt);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const read = utcClock(readAt);
  return (
    <span className="fl-clock">
      <span aria-hidden="true">
        <span className="iw-blink fl-dot">●</span> {utcClock(now)} UTC
      </span>
      <span className="fl-clock-read">
        <span className="sr-only">This page shows your fleet </span>
        as of <time dateTime={new Date(readAt).toISOString()}>{read}</time>
        <span className="sr-only"> UTC</span>
      </span>
    </span>
  );
}
