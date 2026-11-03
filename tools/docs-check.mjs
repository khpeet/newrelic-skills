#!/usr/bin/env node
// Dev-only drift check for docs pages mirrored verbatim in shared/<family>/references/*.md. Each mirror names its
// page in a `source:` frontmatter line; this fetches that page's live `.md` rendering from docs.newrelic.com and
// diffs it against the local copy. Network required, no API key involved; not part of `npm test`.
// Usage: node tools/docs-check.mjs [--update]   (exits 1 on drift; --update overwrites the local copies instead)

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unifiedDiff } from '../skills/workflow-automation/publish-workflow/scripts/publish-workflow.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const update = process.argv.includes('--update');
const DOCS_HOST = 'docs.newrelic.com';
const TIMEOUT_MS = 30_000;
const SOURCE = /^---\n[\s\S]*?^source:\s*(\S+)\s*$[\s\S]*?^---\n/m;

const listDirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);

async function fetchLive(source) {
  const url = new URL(`${source.replace(/\/$/, '')}.md`);
  if (url.protocol !== 'https:' || url.hostname !== DOCS_HOST) throw new Error(`source must be an https://${DOCS_HOST}/ page (got ${source})`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (new URL(response.url).hostname !== DOCS_HOST) throw new Error(`${url} redirected off ${DOCS_HOST} to ${new URL(response.url).hostname}`);
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

let drifted = 0;
let failed = 0;
for (const family of listDirs(join(root, 'shared'))) {
  const dir = join(root, 'shared', family, 'references');
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const rel = ['shared', family, 'references', file].join('/');
    const local = readFileSync(join(dir, file), 'utf8');
    const source = local.match(SOURCE)?.[1];
    if (!source) continue;
    let live;
    try {
      live = await fetchLive(source);
    } catch (err) {
      console.error(`${rel}: could not fetch live page: ${err.message}`);
      failed++;
      continue;
    }
    if (live === local) {
      console.error(`${rel}: matches ${source}`);
      continue;
    }
    if (update) {
      writeFileSync(join(dir, file), live);
      console.error(`${rel}: updated from ${source}`);
      continue;
    }
    drifted++;
    const { diff, truncated } = unifiedDiff(local, live, { oldLabel: rel, newLabel: `${source}.md` });
    console.log(diff + (truncated ? '... (diff truncated)\n' : ''));
    console.error(`${rel}: differs from ${source}`);
  }
}

if (update && !failed) console.error('Run `npm run sync` to copy the updated references into the skills.');
if (failed) process.exit(2);
if (drifted) {
  console.error(`${drifted} mirrored page(s) drifted. Review the diff, then run \`npm run docs:check -- --update\` and \`npm run sync\`.`);
  process.exit(1);
}
