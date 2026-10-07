import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(root, 'annotate.js'), 'utf8');
const marker = '})(typeof window !== "undefined" ? window : null, function (host) {';
const start = source.indexOf(marker);
if (start < 0 || source.indexOf(marker, start + 1) >= 0) {
  throw new Error('Could not locate the unique Annotate factory marker');
}
const tail = source.slice(start + marker.length).trimEnd();
if (!tail.endsWith('});')) {
  throw new Error('Annotate factory must end with });');
}
// The classic adapter calls the same factory and boots itself. The ESM entry
// exposes the controller without booting, so the importer chooses when to init.
const factory = `function (host) {${tail.slice(0, -2)}`;
const output = `// Generated from annotate.js by scripts/build.mjs. Do not edit directly.\n` +
  `const createController = ${factory};\n` +
  `const Annotate = createController(typeof window !== "undefined" ? window : null);\n` +
  `const init = (config) => Annotate.init(config);\n` +
  `const destroy = () => Annotate.destroy();\n` +
  `export { init, destroy };\n` +
  `export default Annotate;\n`;
await writeFile(join(root, 'annotate.mjs'), output);

// TypeScript's NodeNext resolver distinguishes ESM and CommonJS declarations.
const declarations = await readFile(join(root, 'annotate.d.ts'), 'utf8');
await writeFile(join(root, 'annotate.d.mts'), '// Generated from annotate.d.ts. Do not edit directly.\n' + declarations);
