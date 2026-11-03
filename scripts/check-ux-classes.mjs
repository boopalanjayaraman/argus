// Fails if App.tsx uses an ar-* class that exists neither in the design
// bundle.css nor in the UX source markup (Main.dc.html). Invented classes
// are silent in CSS; this makes them a build error.
import fs from 'node:fs';
const css = fs.readFileSync('src/apps/web/public/ds/argus/components/bundle.css', 'utf8');
const dc = fs.readFileSync('docs/ux/Argus click-through-html/Main.dc.html', 'utf8');
const known = new Set([
  ...[...css.matchAll(/\.(ar-[a-z0-9-]+)/g)].map(m => m[1]),
  ...[...dc.matchAll(/ar-[a-z0-9-]+/g)].map(m => m[0]),
]);
const src = fs.readFileSync('src/apps/web/src/App.tsx', 'utf8');
const used = new Set([...src.matchAll(/ar-[a-z][a-z0-9-]*/g)].map(m => m[0]));
const unknown = [...used].filter(c => !known.has(c));
if (unknown.length) { console.error('Invented UX classes (not in bundle.css or Main.dc.html):', unknown.join(', ')); process.exit(1); }
console.log(`UX class check passed: ${used.size} ar-* classes used, all from the design source.`);
