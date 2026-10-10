#!/usr/bin/env node
// Runs from the "version" lifecycle hook: `npm version patch` bumps
// package.json, then this rewrites every hard-coded copy of the previous
// version (the VERSION constant and api.version in annotate.js, the CDN
// URLs and API example in README.md, the examples and the version test) so
// the published file always reports the version npm says it is.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const next = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const source = readFileSync(join(ROOT, "annotate.js"), "utf8");
const prev = (source.match(/var VERSION = "([^"]+)"/) || [])[1];
if (!prev) throw new Error("annotate.js has no VERSION constant");
if (prev === next) { console.log(`version already ${next}`); process.exit(0); }
const escaped = prev.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const files = ["annotate.js", "README.md", "index.html", "examples/wordpress.php", "tests/annotate.spec.js"];
for (const file of files) {
  const path = join(ROOT, file);
  let text;
  try { text = readFileSync(path, "utf8"); } catch { continue; }
  const re = new RegExp(`(?<![\\d.])${escaped}(?![\\d])`, "g");
  const out = text.replace(re, next);
  const n = (text.match(re) || []).length;
  if (n) { writeFileSync(path, out); console.log(`${file}: ${n} × ${prev} → ${next}`); }
}
