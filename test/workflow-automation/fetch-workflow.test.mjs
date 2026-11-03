import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeYaml, main } from '../../skills/workflow-automation/fetch-workflow/scripts/fetch-workflow.mjs';

const KEY = 'NRAK-SECRETKEY123';
const env = { NEW_RELIC_API_KEY: KEY, NEW_RELIC_ACCOUNT_ID: '1234' };
const YAML = 'name: alpha\nsteps:\n  - name: s1\n    type: action\n';

const page = (results, nextCursor = null) => ({
  data: { actor: { account: { workflowAutomation: { workflows: { nextCursor, results } } } } },
});
const def = (name, version, yaml) => ({ definition: { name, version, ...(yaml && { yaml }) } });

// Fake NerdGraph: two list pages, and a get endpoint that returns base64 YAML.
function fakeFetch(calls) {
  return async (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    calls.push({ query, variables });
    let body;
    if (query.includes('ListWorkflows')) {
      body = variables.cursor
        ? page([def('alpha', 2), def('beta', 1)])
        : page([def('alpha', 1), def('gamma', 5)], 'cursor-2');
    } else {
      body =
        variables.name === 'alpha'
          ? { data: { actor: { account: { workflowAutomation: { workflow: def('alpha', variables.version, Buffer.from(YAML).toString('base64')) } } } } }
          : { data: { actor: { account: { workflowAutomation: { workflow: null } } } } };
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

function capture() {
  const out = { text: '', write(s) { this.text += s; } };
  return out;
}

let cwd;
let calls;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'fetch-wf-'));
  calls = [];
});

const run = async (argv, extra = {}) => {
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, { env, stdout, stderr, cwd, fetchImpl: fakeFetch(calls), ...extra });
  return { code, stdout: stdout.text, stderr: stderr.text };
};

test('list prints name and latestVersion only by default', async () => {
  const { code, stdout } = await run(['list']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), [
    { name: 'alpha', latestVersion: 2 },
    { name: 'beta', latestVersion: 1 },
    { name: 'gamma', latestVersion: 5 },
  ]);
});

test('list --versions paginates and groups versions by name', async () => {
  const { code, stdout } = await run(['list', '--versions']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), [
    { name: 'alpha', latestVersion: 2, versions: [1, 2] },
    { name: 'beta', latestVersion: 1, versions: [1] },
    { name: 'gamma', latestVersion: 5, versions: [5] },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].variables.accountId, 1234);
});

test('list --limit returns the first n by name and reports the total on stderr', async () => {
  const { code, stdout, stderr } = await run(['list', '--limit', '2']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout).map((w) => w.name), ['alpha', 'beta']);
  assert.match(stderr, /Showing the first 2 of 3 workflows/);
  const all = await run(['list', '--limit', '10']);
  assert.equal(JSON.parse(all.stdout).length, 3);
  assert.equal(all.stderr, '');
});

test('list --limit must be a positive integer, checked before any API call', async () => {
  for (const bad of ['0', '1.5', 'ten']) {
    const { code, stderr } = await run(['list', '--limit', bad]);
    assert.equal(code, 1, bad);
    assert.match(stderr, /--limit must be a positive integer/);
  }
  assert.equal(calls.length, 0);
});

test('get --version must be a positive integer, checked before any API call', async () => {
  for (const bad of ['0', '1.5', 'two']) {
    const { code, stderr } = await run(['get', '--name', 'alpha', '--version', bad]);
    assert.equal(code, 1, bad);
    assert.match(stderr, /--version must be a positive integer/);
  }
  assert.equal(calls.length, 0);
});

test('--account overrides env account id', async () => {
  await run(['list', '--account', '999']);
  assert.equal(calls[0].variables.accountId, 999);
});

test('get resolves latest version, decodes base64, writes default path', async () => {
  const { code, stdout } = await run(['get', '--name', 'alpha']);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.version, 2);
  assert.equal(result.path, join(cwd, 'workflows', 'alpha.yaml'));
  assert.equal(readFileSync(result.path, 'utf8'), YAML);
  assert.equal(calls.at(-1).variables.version, 2);
});

test('get warns about plaintext secrets in the saved file: count and paths, never values', async () => {
  const nrak = `NRAK-${'A'.repeat(27)}`;
  const secretYaml = `name: alpha\nsteps:\n  - name: s1\n    type: action\n    action: newrelic.ingest.sendLogs\n    version: 1\n    inputs:\n      apiKey: ${nrak}\n`;
  const fetchImpl = async (url, init) => {
    const { query } = JSON.parse(init.body);
    const body = query.includes('ListWorkflows')
      ? page([def('alpha', 1)])
      : { data: { actor: { account: { workflowAutomation: { workflow: def('alpha', 1, Buffer.from(secretYaml).toString('base64')) } } } } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const { code, stdout, stderr } = await run(['get', '--name', 'alpha'], { fetchImpl });
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.plaintextSecrets, { count: 1, paths: ['steps[0].inputs.apiKey'] });
  assert.match(result.hint, /plaintext secrets/);
  assert.ok(!stdout.includes(nrak) && !stderr.includes(nrak));
  assert.equal(readFileSync(result.path, 'utf8'), secretYaml);
});

test('get reports secretScanSkipped when the saved YAML cannot be scanned (anchors)', async () => {
  const anchored = 'name: alpha\nsteps:\n  - name: s1\n    type: action\n    action: newrelic.ingest.sendLogs\n    version: 1\n    inputs:\n      base: &b\n        password: dummypassword\n';
  const fetchImpl = async (url, init) => {
    const { query } = JSON.parse(init.body);
    const body = query.includes('ListWorkflows')
      ? page([def('alpha', 1)])
      : { data: { actor: { account: { workflowAutomation: { workflow: def('alpha', 1, Buffer.from(anchored).toString('base64')) } } } } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const { code, stdout } = await run(['get', '--name', 'alpha'], { fetchImpl });
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.secretScanSkipped, true);
  assert.match(result.hint, /could not be scanned/);
  assert.equal(result.plaintextSecrets, undefined);
  assert.ok(!stdout.includes('dummypassword'));
});

test('get without plaintext secrets adds no warning fields', async () => {
  const { stdout } = await run(['get', '--name', 'alpha']);
  const result = JSON.parse(stdout);
  assert.equal(result.plaintextSecrets, undefined);
  assert.equal(result.secretScanSkipped, undefined);
  assert.equal(result.hint, undefined);
});

test('get with a different letter case resolves the server\'s exact name before fetching', async () => {
  const { code, stdout } = await run(['get', '--name', 'Alpha']);
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.equal(result.name, 'alpha');
  assert.equal(result.path, join(cwd, 'workflows', 'alpha.yaml'));
  assert.equal(calls.at(-1).variables.name, 'alpha');
  assert.equal(calls.at(-1).variables.version, 2);
});

test('get --version with a different letter case resolves the exact name only after the exact-name call fails', async () => {
  const { code, stdout } = await run(['get', '--name', 'Alpha', '--version', '1']);
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).name, 'alpha');
  const names = calls.filter((c) => c.variables.name).map((c) => c.variables.name);
  assert.deepEqual(names, ['Alpha', 'alpha']);
  assert.equal(calls.at(-1).variables.version, 1);
});

test('get --version for a workflow that does not exist reports the original not-found error', async () => {
  const { code, stderr } = await run(['get', '--name', 'nope', '--version', '1']);
  assert.equal(code, 2);
  assert.match(stderr, /Workflow "nope" version 1 not found/);
});

test('get with --version skips list lookup', async () => {
  const { code } = await run(['get', '--name', 'alpha', '--version', '1', '--out', 'x/a.yaml']);
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(readFileSync(join(cwd, 'x/a.yaml'), 'utf8'), YAML);
});

test('get refuses to overwrite without --force', async () => {
  const target = join(cwd, 'existing.yaml');
  writeFileSync(target, 'keep me');
  const refused = await run(['get', '--name', 'alpha', '--version', '1', '--out', 'existing.yaml']);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /already exists/);
  assert.equal(readFileSync(target, 'utf8'), 'keep me');
  const forced = await run(['get', '--name', 'alpha', '--version', '1', '--out', 'existing.yaml', '--force']);
  assert.equal(forced.code, 0);
  assert.equal(readFileSync(target, 'utf8'), YAML);
});

test('get rejects invalid names (path traversal) before any request', async () => {
  const { code, stderr } = await run(['get', '--name', '../etc/passwd']);
  assert.equal(code, 1);
  assert.match(stderr, /Invalid workflow name/);
  assert.equal(calls.length, 0);
});

test('get rejects an invalid name returned by the server and writes nothing', async () => {
  const evil = async () =>
    new Response(JSON.stringify({ data: { actor: { account: { workflowAutomation: { workflow: def('../../evil', 1, Buffer.from(YAML).toString('base64')) } } } } }), { status: 200 });
  const { code, stderr } = await run(['get', '--name', 'alpha', '--version', '1'], { fetchImpl: evil });
  assert.equal(code, 2);
  assert.match(stderr, /invalid workflow name "\.\.\/\.\.\/evil"/);
  assert.deepEqual(readdirSync(cwd), []);
});

test('get reports unknown workflow with exit 2', async () => {
  const { code, stderr } = await run(['get', '--name', 'missing']);
  assert.equal(code, 2);
  assert.match(stderr, /not found/);
});

test('missing api key is a usage error and never prints key values', async () => {
  const { code, stderr } = await run(['list'], { env: { NEW_RELIC_ACCOUNT_ID: '1' } });
  assert.equal(code, 1);
  assert.match(stderr, /NEW_RELIC_API_KEY is not set/);
});

test('env command never prints the key', async () => {
  const { code, stdout } = await run(['env']);
  assert.equal(code, 0);
  assert.ok(!stdout.includes(KEY));
  assert.equal(JSON.parse(stdout).NEW_RELIC_API_KEY, 'set');
});

test('missing account id is a usage error', async () => {
  const { code, stderr } = await run(['list'], { env: { NEW_RELIC_API_KEY: KEY } });
  assert.equal(code, 1);
  assert.match(stderr, /Account id required/);
});

test('decodeYaml passes through plain YAML', () => {
  assert.equal(decodeYaml(YAML), YAML);
  assert.equal(decodeYaml(Buffer.from(YAML).toString('base64')), YAML);
});
