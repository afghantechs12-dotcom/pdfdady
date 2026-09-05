/* global process, console */
/** Run with: node --import tsx scripts/recording-ui-ux-probe.mjs --out <path>
 * Geometry timings are NOT browser input-to-paint or production acceptance.
 * This probe always preserves unavailable browser metrics as NOT_EXERCISED.
 */
import { performance } from 'node:perf_hooks';
import { cpus, platform, release } from 'node:os';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PartialInkGesture } from '../src/application/editor/tools/partialEraser.ts';
import { createEditorInstance } from '../lib/editor/createEditorInstance.ts';
import { createDrawing } from '../src/domain/editor/objectFactories.ts';
import { getActivePage } from '../src/domain/editor/document.ts';
import { EraseInkCommand } from '../src/application/editor/commands/EraseInkCommand.ts';
const outAt = process.argv.indexOf('--out');
const out = outAt >= 0 ? process.argv[outAt + 1] : 'recording-ui-ux-result.json';
const results = [];
for (const count of [20, 1000]) {
  const ed = createEditorInstance();
  const layer = getActivePage(ed.getState()).layerStack.layers[0].id;
  for (let i = 0; i < count; i++) ed.addObject(createDrawing({ x: (i % 20) * 25, y: Math.floor(i / 20) * 12 }, layer,
    Array.from({ length: 40 }, (_, n) => ({ x: n, y: Math.sin(n / 4) * 4 })), { smoothing: true }));
  const page = getActivePage(ed.getState());
  const t = performance.now();
  const g = new PartialInkGesture(page, { x: 100, y: 0 }, 8);
  const initializationMs = performance.now() - t;
  const samples = [];
  for (let y = 1; y <= 100; y++) { const at = performance.now(); g.move({ x: 100, y: y * 5 }); samples.push(performance.now() - at); }
  const at = performance.now();
  if (g.replacements.size) ed.execute(new EraseInkCommand(page, g.replacements));
  const commitMs = performance.now() - at;
  const ordered = [...samples].sort((a, b) => a - b);
  results.push({ fixture: `${count} smoothed strokes, 40 points each, one page, 100 swept samples`, initializationMs,
    geometryP95Ms: ordered[Math.ceil(ordered.length * .95) - 1], maxGeometryMs: ordered.at(-1), commitMs, rawSamplesMs: samples });
}
const report = { host: { os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, node: process.version },
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  scope: 'Local Node geometry microbenchmark; excludes DOM, painting, PDF parsing and server work', results,
  browser: Object.fromEntries(['shell', 'firstPage', 'interactiveEdit', 'handoff', 'shapePaintP95', 'eraserPaintP95', 'longTasks', 'CLS', 'thumbnails', 'save', 'publish', 'export', 'consoleErrors', 'unhandledRejections', 'failedRequests', 'hydrationErrors'].map(k => [k, { status: 'NOT_EXERCISED', reason: 'No accepted app browser runtime in this run' }])),
  verdict: 'INCOMPLETE' };
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output: out, results: results.map(({ rawSamplesMs, ...r }) => r), verdict: report.verdict }, null, 2));
