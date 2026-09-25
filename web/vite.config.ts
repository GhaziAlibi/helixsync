import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    // The units under test (crypto, the REST client, small pure helpers) need
    // no DOM: Node provides fetch, WebCrypto, atob/btoa. Component behaviour
    // is not covered here.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
