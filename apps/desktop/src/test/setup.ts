import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// React Testing Library does not auto-clean when `globals: true` is combined
// with the jsdom environment in every setup, so be explicit.
afterEach(() => {
  cleanup();
});
