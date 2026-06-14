"use client";

import { useState } from "react";

export default function Faq() {
  const [openIndex, setOpenIndex] = useState(0);

  const items = [
    {
      q: "Do I need to know how to code?",
      a: "Nope. You'll paste one command to wake a device, then copy a link into your AI app. If you can copy and paste, you're set. Writing your own abilities is optional — and yes, it's developer-friendly when you want it.",
    },
    {
      q: "Is it safe to connect my computer?",
      a: "Very. Your computer never opens a port or accepts incoming connections — it dials out to Finch and only ever responds to requests you've authorized. Finch verifies every caller at the door before anything reaches your device.",
    },
    {
      q: "Which AI apps work with Finch?",
      a: "Anything that speaks MCP — including Claude and Cursor — plus a growing list of clients. If your app supports MCP servers, it works with Finch out of the box.",
    },
    {
      q: "What happens when my device is turned off?",
      a: "It rests. Finch shows it as \"resting\" so you always know, and wakes it the moment it comes back online — no reconnecting, no fiddling.",
    },
    {
      q: "What can my AI actually do with it?",
      a: "Anything you can package as a small tool: printing, transcription, searching your notes, reading the web, running your home, and more. Start with a ready-made ability or bring your own.",
    },
  ];

  return (
    <section className="sec" id="faq">
      <div className="wrap">
        <div className="sec-head">
          <span className="sec-tag">QUESTIONS</span>
          <h2>Good to know</h2>
        </div>
        <div className="faq">
          {items.map((item, i) => (
            <details
              key={i}
              open={openIndex === i}
              onToggle={() => {}}
            >
              <summary
                onClick={(e) => {
                  e.preventDefault();
                  setOpenIndex(openIndex === i ? -1 : i);
                }}
              >
                {item.q} <span className="pm">+</span>
              </summary>
              <div className="ans">{item.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
