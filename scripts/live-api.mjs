/**
 * Runs the live-API checks against the real OpenAlex and arXiv services.
 *
 * A tiny runner rather than an inline env var in package.json, because
 * `LIVE_API=1 vitest` is POSIX-only and would fail on Windows.
 *
 * It launches vitest's JS entry point with the current node binary rather
 * than spawning `npx`: on Windows, spawning a `.cmd` without a shell throws
 * EINVAL under recent Node, and spawning *with* a shell would mean quoting
 * arguments by hand.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
// Resolve vitest's own entry point through node's resolver, so this keeps
// working regardless of how node_modules is laid out.
const vitestBin = require.resolve("vitest/vitest.mjs");

const child = spawn(process.execPath, [vitestBin, "run", "tests/live-api.test.ts"], {
  stdio: "inherit",
  env: { ...process.env, LIVE_API: "1" },
});

child.on("exit", (code) => process.exit(code ?? 1));
