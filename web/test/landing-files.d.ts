declare module "@/scripts/landing-files.mjs" {
  export const LANDING_STATIC_FILES: string[];
  export function missingLandingFiles(publicDir: string, files?: string[]): string[];
}
