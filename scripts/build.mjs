// Inlines local <script src="..."> tags so dist/index.html is one file you can
// host anywhere. three.js stays on the CDN.
//   node scripts/build.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let html = await readFile(resolve(root, 'index.html'), 'utf8');

const tags = [...html.matchAll(/<script src="(?!https?:)([^"]+)"><\/script>/g)];
for (const [tag, src] of tags) {
  const code = await readFile(resolve(root, src), 'utf8');
  html = html.replace(tag, () => `<script>\n${code.replace(/<\/script/gi, '<\\/script')}\n</script>`);
}

await mkdir(resolve(root, 'dist'), { recursive: true });
await writeFile(resolve(root, 'dist/index.html'), html);
console.log(`dist/index.html (${(html.length / 1024).toFixed(1)} kB, ${tags.length} scripts inlined)`);
