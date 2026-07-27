<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Heed deprecation notices.

**Verify before you write.** This install ships **no** bundled prose docs — there is no
`node_modules/next/dist/docs/` (an earlier version of this file pointed there; the path
does not exist). Check the pinned version first (`node -p "require('next/package.json').version"`,
currently **15.5.20**), then confirm any API you are unsure of against what is actually
installed, not against recall:

- `node_modules/next/dist/types.d.ts` and `node_modules/next/types/` — the real exported types
- `node_modules/next/dist/server/` and `.../client/` — the implementation
- the build output in `.next/` (e.g. `.next/routes-manifest.json`) when you need to know
  what a config option actually produces on the wire

If a behaviour cannot be settled from the installed package, say so rather than guessing.
<!-- END:nextjs-agent-rules -->
