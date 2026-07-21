import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

// `dist/` is generated exclusively by TypeScript. Cleaning this exact,
// package-local directory prevents stale deleted modules or test artifacts from
// being included when `npm pack`/`npm publish` runs the prepack build.
const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const distDirectory = path.resolve(scriptsDirectory, "..", "dist");
await rm(distDirectory, { recursive: true, force: true });
