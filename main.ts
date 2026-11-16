// Driver for the fast marked-compatible renderer.
// The harness runs `node /bot/main.ts` (Node 22, types stripped natively).
// It reads every case from $MAKEFUN_INPUT_DIR/cases.json (default /input),
// renders each one alone with parse() from parse.js, and writes
// $MAKEFUN_OUTPUT_DIR/html.json: a JSON array of the HTML strings, one per
// case and in the cases' order.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html = cases.map((c) => parse(c.markdown));
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
