// Vitest global setup: register @testing-library/jest-dom matchers (toBeInTheDocument,
// toHaveTextContent, …) and auto-unmount React trees between tests.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
