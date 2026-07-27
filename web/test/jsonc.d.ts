declare module "@/scripts/jsonc.mjs" {
  export function stripJsoncComments(raw: string): string;
  export function parseJsonc(raw: string): any;
  export function readJsonc(path: string): any;
}
