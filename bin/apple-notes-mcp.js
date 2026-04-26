#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = resolve(__dirname, "..", "index.ts");

execFileSync("npx", ["tsx", entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
