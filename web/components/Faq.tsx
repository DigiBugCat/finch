"use client";

import { useState } from "react";

export default function Faq() {
  const [openIndex, setOpenIndex] = useState(0);

  const items = [
    {
      q: "Do I have to write the MCP server myself?",
      a: "Only if you want to — Finch hosts the server logic, it doesn't write it. Bring a FastMCP (or any MCP) server and Finch wraps it in auth and a public URL. If you've shipped a FastMCP server, you already know the shape. Not in the mood? Grab a ready-made ability and flash it onto a box in a minute.",
    },
    {
      q: "Is it actually safe to put my box on the internet?",
      a: "You're not exposing anything. Your box never opens a port or accepts an inbound connection — it dials out to Finch over an outbound tunnel and only answers calls you've authorized. Finch verifies every caller at the door before anything reaches your code. No reverse proxy, no exposed IP, no CGNAT gymnastics.",
    },
    {
      q: "Which clients can call it?",
      a: "Anything that speaks MCP — Claude, Cursor, Windsurf, and a growing list of clients, plus your own code over the protocol. If it can add an MCP server by URL, it works with Finch out of the box.",
    },
    {
      q: "What happens when my box goes offline?",
      a: "It rests. Finch marks the endpoint \"resting\" so you always know, and re-homes it the moment the box is back — no re-running the installer, no re-pasting URLs.",
    },
    {
      q: "What can I actually expose through it?",
      a: "Anything you can wrap as an MCP tool: printing, transcription, a notes index, web fetch, home automation, your own scripts. Start from a ready-made ability or bring your own server.",
    },
    {
      q: "Is it free?",
      a: "Yes — Finch is in beta, so it's free to use right now. Paid plans come later, once it's out of beta. We'll give you plenty of warning before anything changes.",
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
            <details key={i} open={openIndex === i}>
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
