import { afterAll, beforeEach } from "vitest";

/** Apply route-test environment variables for each test and restore the
 * process-wide values when the file finishes, preventing cross-file leaks. */
export function setupTestEnv(values: Record<string, string>): void {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]] as const),
  );
  beforeEach(() => {
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
  });
  afterAll(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
