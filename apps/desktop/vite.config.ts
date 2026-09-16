// `vitest/config` re-exports Vite's `defineConfig` with the `test` key typed.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// Tauri drives the dev server on a fixed port and cannot recover from a port
// change, hence `strictPort`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: {
      // Rust sources are watched by cargo, not by Vite.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: "chrome120",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // Each file boots its own jsdom and module graph, so a worker costs a core
    // and a heap. At one worker per core all 21 files oversubscribe the box: a
    // test that needs about 2s of real work gets starved past the default 5s
    // timeout, and React Testing Library's 1s element queries start failing
    // too. A quarter of the parallelism keeps workers from crowding each other,
    // and the timeout absorbs what a busy machine adds on top of that.
    maxWorkers: "25%",
    testTimeout: 15000,
  },
});
