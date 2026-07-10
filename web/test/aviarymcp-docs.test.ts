import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('AviaryMCP machine-readable documentation', () => {
  it('publishes and links the project guide on the current Finch origin', () => {
    const page = read('app/docs/aviarymcp/page.tsx');
    const fleetGuide = read('public/llms.txt');
    const projectGuide = read('public/aviarymcp-llms.txt');

    expect(page).toContain('href="/aviarymcp-llms.txt"');
    expect(page).not.toContain('github.com/DigiBugCat/aviary-mcp');
    expect(fleetGuide).toContain('`/aviarymcp-llms.txt` on this origin');
    expect(projectGuide).toContain('mcp = AviaryMCP("My MCP Server")');
    expect(projectGuide).toContain('@mcp.tool');
    expect(projectGuide).toContain('mcp.run(');
  });
});
