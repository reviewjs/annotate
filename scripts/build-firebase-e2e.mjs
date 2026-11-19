// Bundles the Firebase SDK + transport for the browser end-to-end test.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await build({
  entryPoints: [join(root, "tests/fixtures/firebase-entry.mjs")],
  outfile: join(root, "dist/firebase-e2e.js"),
  bundle: true, format: "iife", platform: "browser", target: "es2020", logLevel: "warning",
});
