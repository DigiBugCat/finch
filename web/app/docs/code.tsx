// The docs' code block. Its source is plain text: anything that looks like
// markup (<slug>, <name>, <img …>) is shown exactly as written. The only
// markup it understands is the two highlight spans the docs use:
//
//   <span class="c">a comment</span>   <span class="o">command output</span>
//
// A few HTML entities (&lt; &gt; &amp; &quot; &#39; &apos;) are decoded so
// older snippets written for innerHTML still read right. Nothing is ever
// passed to dangerouslySetInnerHTML, so a placeholder can't vanish as an
// unknown tag and a snippet can't inject markup.
import { Fragment, type ReactNode } from 'react';

const SPAN = /<span class="(c|o)">([\s\S]*?)<\/span>/g;
const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};
const ENTITY = /&(?:lt|gt|amp|quot|#39|apos);/g;

function decode(text: string): string {
  return text.replace(ENTITY, (e) => ENTITIES[e]);
}

/** Split a snippet into text and highlight spans, as React nodes. */
export function codeNodes(source: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of source.matchAll(SPAN)) {
    if (m.index > last) nodes.push(<Fragment key={key++}>{decode(source.slice(last, m.index))}</Fragment>);
    nodes.push(<span key={key++} className={m[1]}>{decode(m[2])}</span>);
    last = m.index + m[0].length;
  }
  if (last < source.length) nodes.push(<Fragment key={key++}>{decode(source.slice(last))}</Fragment>);
  return nodes;
}

export default function Code({ children }: { children: string }) {
  return (
    <pre className="docs-code">
      <code>{codeNodes(children)}</code>
    </pre>
  );
}
