import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    // jsdom, not node: the feed/Atom parsers use the platform `DOMParser`,
    // which is what Obsidian (Electron) provides at runtime. Testing against
    // jsdom's implementation keeps the parsing code free of any XML library
    // in the shipped bundle — and gives the settings tab a real DOM to render
    // into during the integration tests.
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    alias: {
      // At runtime, `obsidian` resolves to a working fake so tests can drive
      // the real plugin class (see tests/fakes/obsidian.ts). Type-checking
      // still uses the genuine `obsidian` package, so the plugin is written
      // against the real API and a signature mismatch is a compile error.
      obsidian: fileURLToPath(new URL("./tests/fakes/obsidian.ts", import.meta.url)),
    },
  },
});
