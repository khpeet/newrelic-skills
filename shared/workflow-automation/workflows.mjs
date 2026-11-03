// Workflow definition helpers shared by workflow-automation skills: list/get queries, YAML base64 encoding, stdin reading.
// Source of truth: shared/workflow-automation/workflows.mjs — run `npm run sync` after editing.

import { createHash } from 'node:crypto';
import { constants, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ApiError, UsageError, nerdgraph } from './nerdgraph.mjs';
import { assertNoSymlinks } from './paths.mjs';

// Workflow names must match this pattern per the definition schema; also keeps a name safe to use in a file path.
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
// Guard against an unexpectedly endless cursor chain; hitting it is an error, because callers decide create-vs-update and "latest" from this list.
const MAX_PAGES = 50;

const LIST_QUERY = `query ListWorkflows($accountId: Int!, $cursor: String) {
  actor { account(id: $accountId) { workflowAutomation {
    workflows(cursor: $cursor) { nextCursor results { definition { name version } } }
  } } }
}`;

export const GET_QUERY = `query GetWorkflow($accountId: Int!, $name: String!, $version: Int!) {
  actor { account(id: $accountId) { workflowAutomation {
    workflow(name: $name, version: $version) { definition { name version yaml } }
  } } }
}`;

export async function listWorkflows(accountId, config, opts) {
  const byName = new Map();
  const seenCursors = new Set();
  let cursor = null;
  for (let page = 0; ; page++) {
    const data = await nerdgraph(LIST_QUERY, { accountId, cursor }, config, opts);
    const workflows = data?.actor?.account?.workflowAutomation?.workflows;
    for (const { definition } of workflows?.results ?? []) {
      if (!definition?.name) continue;
      const versions = byName.get(definition.name) ?? new Set();
      versions.add(Number(definition.version));
      byName.set(definition.name, versions);
    }
    cursor = workflows?.nextCursor;
    if (!cursor) break;
    if (seenCursors.has(cursor)) {
      throw new ApiError('Workflow list pagination did not advance (the server repeated a cursor); refusing to continue with an incomplete list.');
    }
    seenCursors.add(cursor);
    if (page + 1 >= MAX_PAGES) {
      throw new ApiError(`Account has more than ${MAX_PAGES} pages of workflow definitions; the list would be incomplete, so this command cannot safely continue.`);
    }
  }
  return [...byName.entries()]
    .map(([name, versions]) => {
      const sorted = [...versions].sort((a, b) => a - b);
      return { name, latestVersion: sorted.at(-1), versions: sorted };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// A --version value: undefined stays undefined; otherwise a positive integer.
export function parseVersion(raw) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new UsageError(`--version must be a positive integer (got "${raw}").`);
  return Number(raw);
}

// Looks `name` up in a listWorkflows() result. Names are unique case-insensitively (verified live), so a workflow whose
// name differs only in letter case is reported separately instead of being treated as the same workflow.
export function findWorkflow(workflows, name) {
  const lower = name.toLowerCase();
  return {
    match: workflows.find((w) => w.name === name),
    caseVariants: workflows.filter((w) => w.name !== name && w.name.toLowerCase() === lower),
  };
}

// Fetches one version of a published definition. Returns {definition, yaml} with the YAML decoded.
export async function getDefinition(accountId, name, version, config, opts) {
  const data = await nerdgraph(GET_QUERY, { accountId, name, version }, config, opts);
  const definition = data?.actor?.account?.workflowAutomation?.workflow?.definition;
  if (!definition?.yaml) throw new ApiError(`Workflow "${name}" version ${version} not found in account ${accountId}.`);
  return { definition, yaml: decodeYaml(definition.yaml) };
}

// Writes `content` to `path` (creating parent folders), refusing to overwrite an existing file unless `force`.
// Never writes through a symbolic link, even with `force`: `path`, its folder, and (when `root` is the project
// directory) every folder between them must be real. O_NOFOLLOW makes the open itself refuse a link planted after the check.
export function writeNoOverwrite(path, content, force, root) {
  assertNoSymlinks(path, root);
  mkdirSync(dirname(path), { recursive: true });
  try {
    const flag = constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (force ? constants.O_TRUNC : constants.O_EXCL);
    // 0600: fetched or drafted YAML can hold plaintext secrets. The mode applies only when the file is created.
    writeFileSync(path, content, { flag, mode: 0o600 });
  } catch (err) {
    if (err.code === 'ELOOP') throw new UsageError(`Refusing to write through the symbolic link ${path}.`);
    if (err.code === 'EEXIST') throw new UsageError(`${path} already exists. Pass --force to overwrite or --out to choose another path.`);
    throw err;
  }
}

// Line endings and trailing newlines are not content when comparing a local file with a published version.
export const normalizeNewlines = (text) => text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');

// The API returns yaml as base64; fall back to raw text as a safeguard
export function decodeYaml(value) {
  const compact = value.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length % 4 === 0) {
    return Buffer.from(compact, 'base64').toString('utf8');
  }
  return value;
}

// First 12 hex chars of sha256: binds a plan's "expect" token to the exact bytes or inputs the user confirmed.
export const sha12 = (data) => createHash('sha256').update(data).digest('hex').slice(0, 12);

// The API takes yaml as base64 (SecureValue).
export function encodeYaml(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

export async function readBytes(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// What is hashed, diffed, and published must equal the file's bytes, so anything that does not decode losslessly is refused
// (a lossy decode would turn bad bytes into U+FFFD). ignoreBOM keeps a leading BOM as a character.
export function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new UsageError(`${label} is not valid UTF-8; re-save it as UTF-8.`);
  }
}

export async function readStream(stream) {
  return (await readBytes(stream)).toString('utf8');
}
