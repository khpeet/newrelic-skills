import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, getConfig } from '../../shared/workflow-automation/nerdgraph.mjs';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from '../../shared/workflow-automation/nerdgraph.mjs';
import { findWorkflow, getDefinition, listWorkflows, normalizeNewlines, writeNoOverwrite } from '../../shared/workflow-automation/workflows.mjs';

const config = getConfig({ NEW_RELIC_API_KEY: 'NRAK-SECRETKEY123' });
const def = (name, version) => ({ definition: { name, version } });

// Fake NerdGraph list endpoint: `pages(cursor)` returns {results, nextCursor}.
const fakeFetch = (pages, calls = []) => async (url, init) => {
  const { variables } = JSON.parse(init.body);
  calls.push(variables.cursor);
  const workflows = pages(variables.cursor, calls.length);
  return new Response(JSON.stringify({ data: { actor: { account: { workflowAutomation: { workflows } } } } }), { status: 200 });
};

test('listWorkflows merges versions across pages, sorted by name', async () => {
  const pages = (cursor) => (cursor
    ? { results: [def('alpha', 2), def('beta', 1)], nextCursor: null }
    : { results: [def('gamma', 5), def('alpha', 1)], nextCursor: 'c2' });
  const list = await listWorkflows(1, config, { fetchImpl: fakeFetch(pages) });
  assert.deepEqual(list, [
    { name: 'alpha', latestVersion: 2, versions: [1, 2] },
    { name: 'beta', latestVersion: 1, versions: [1] },
    { name: 'gamma', latestVersion: 5, versions: [5] },
  ]);
});

test('listWorkflows refuses a repeated cursor instead of looping', async () => {
  const calls = [];
  const pages = () => ({ results: [def('alpha', 1)], nextCursor: 'same' });
  await assert.rejects(listWorkflows(1, config, { fetchImpl: fakeFetch(pages, calls) }), (err) => err instanceof ApiError && /did not advance/.test(err.message));
  assert.equal(calls.length, 2);
});

test('listWorkflows refuses an incomplete list after 50 pages', async () => {
  const calls = [];
  const pages = (cursor, n) => ({ results: [def(`wf${n}`, 1)], nextCursor: `c${n}` });
  await assert.rejects(listWorkflows(1, config, { fetchImpl: fakeFetch(pages, calls) }), (err) => err instanceof ApiError && /more than 50 pages/.test(err.message));
  assert.equal(calls.length, 50);
});

test('listWorkflows accepts exactly 50 pages when the last has no cursor', async () => {
  const pages = (cursor, n) => ({ results: [def(`wf${n}`, 1)], nextCursor: n < 50 ? `c${n}` : null });
  const list = await listWorkflows(1, config, { fetchImpl: fakeFetch(pages) });
  assert.equal(list.length, 50);
});

test('findWorkflow: exact match wins, case variants are reported separately', () => {
  const list = [{ name: 'alpha', latestVersion: 1, versions: [1] }, { name: 'ALPHA', latestVersion: 2, versions: [2] }, { name: 'beta', latestVersion: 1, versions: [1] }];
  assert.deepEqual(findWorkflow(list, 'alpha'), { match: list[0], caseVariants: [list[1]] });
  assert.deepEqual(findWorkflow(list, 'Alpha'), { match: undefined, caseVariants: [list[0], list[1]] });
  assert.deepEqual(findWorkflow(list, 'gamma'), { match: undefined, caseVariants: [] });
});

test('getDefinition returns the definition and its decoded YAML; a missing one is an ApiError', async () => {
  const yaml = 'name: a\nsteps: []\n';
  const found = async () => new Response(JSON.stringify({ data: { actor: { account: { workflowAutomation: { workflow: { definition: { name: 'a', version: 3, yaml: Buffer.from(yaml).toString('base64') } } } } } } }), { status: 200 });
  const got = await getDefinition(1, 'a', 3, config, { fetchImpl: found });
  assert.equal(got.yaml, yaml);
  assert.equal(got.definition.version, 3);
  const none = async () => new Response(JSON.stringify({ data: { actor: { account: { workflowAutomation: { workflow: null } } } } }), { status: 200 });
  await assert.rejects(getDefinition(1, 'a', 3, config, { fetchImpl: none }), (err) => err instanceof ApiError && err.message === 'Workflow "a" version 3 not found in account 1.');
});

test('writeNoOverwrite creates parent folders and refuses to overwrite without force', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wno-'));
  const path = join(dir, 'a', 'b', 'wf.yaml');
  writeNoOverwrite(path, 'one', false);
  assert.equal(readFileSync(path, 'utf8'), 'one');
  assert.throws(() => writeNoOverwrite(path, 'two', false), (err) => err instanceof UsageError && err.message.includes('already exists. Pass --force to overwrite or --out'));
  assert.equal(readFileSync(path, 'utf8'), 'one');
  writeNoOverwrite(path, 'three', true);
  assert.equal(readFileSync(path, 'utf8'), 'three');
  assert.ok(existsSync(path));
});

test('normalizeNewlines: CRLF and lone CR become LF and trailing newlines are dropped', () => {
  assert.equal(normalizeNewlines('a\r\nb\rc\n\n\n'), 'a\nb\nc');
  assert.equal(normalizeNewlines(''), '');
});

test('writeNoOverwrite creates files readable only by the owner (they may hold secrets)', { skip: process.platform === 'win32' }, async () => {
  const { statSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'wf-mode-'));
  const path = join(dir, 'out', 'w.yaml');
  writeNoOverwrite(path, 'name: x\n', false, dir);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
