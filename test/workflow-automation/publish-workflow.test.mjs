import { test, beforeEach } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { main, redactDiff, unifiedDiff } from '../../skills/workflow-automation/publish-workflow/scripts/publish-workflow.mjs';

const KEY = 'NRAK-SECRETKEY123';
const env = { NEW_RELIC_API_KEY: KEY, NEW_RELIC_ACCOUNT_ID: '1234' };

const VALID = `name: demoWorkflow
description: Logs a message
steps:
  - name: sendLog
    type: action
    action: newrelic.ingest.sendLogs
    version: 1
    inputs:
      logs:
        - message: hello
`;
const EDITED = VALID.replace('message: hello', 'message: hello world');

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
// Independent re-implementation of the token hash: sha12(`${accountId}\n${region}\n${file text}`).
const sha12 = (text, account = 1234, region = 'US') => createHash('sha256').update(Buffer.from(`${account}\n${region}\n${text}`, 'utf8')).digest('hex').slice(0, 12);
const createToken = (text, account, region) => `create#${sha12(text, account, region)}`;
const updateToken = (version, text, account, region) => `update@${version}#${sha12(text, account, region)}`;
const wa = (inner) => ({ data: { actor: { account: { workflowAutomation: inner } } } });
const listResponse = (defs) => wa({ workflows: { nextCursor: null, results: defs.map(([name, version]) => ({ definition: { name, version } })) } });
const mutationResponse = (field, version) => ({ data: { [field]: { definition: { definitionId: 'def-1', name: 'demoWorkflow', version, description: 'Logs a message' } } } });

// Routes on the operation name; `published` is the account's existing workflows: {name: {version: yaml}}.
function router({ published = {}, validate = { valid: true, errors: [] }, mutation } = {}) {
  return ({ query, variables }) => {
    if (query.includes('ValidateWorkflow')) return { body: wa({ workflowDefinitionValidation: validate }) };
    if (query.includes('ListWorkflows')) {
      return { body: listResponse(Object.entries(published).flatMap(([name, versions]) => Object.keys(versions).map((v) => [name, Number(v)]))) };
    }
    if (query.includes('GetWorkflow')) {
      const yaml = published[variables.name]?.[variables.version];
      return { body: wa({ workflow: yaml ? { definition: { name: variables.name, version: variables.version, yaml: b64(yaml) } } : null }) };
    }
    if (query.includes('mutation CreateWorkflow')) return mutation ?? { body: mutationResponse('workflowAutomationCreateWorkflowDefinition', 1) };
    if (query.includes('mutation UpdateWorkflow')) return mutation ?? { body: mutationResponse('workflowAutomationUpdateWorkflowDefinition', 3) };
    throw new Error(`unexpected query: ${query}`);
  };
}

function fakeFetch(calls, respond) {
  return async (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    calls.push({ query, variables });
    const { body, status = 200 } = respond({ query, variables });
    return new Response(JSON.stringify(body), { status });
  };
}

function capture() {
  return { text: '', write(s) { this.text += s; } };
}

let cwd;
let calls;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'publish-wf-'));
  calls = [];
});

const writeWorkflow = (file, text) => {
  mkdirSync(join(cwd, 'workflows'), { recursive: true });
  writeFileSync(join(cwd, 'workflows', file), text);
};

const run = async (argv, { respond = router(), ...extra } = {}) => {
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, { env, stdout, stderr, cwd, fetchImpl: fakeFetch(calls, respond), ...extra });
  assert.ok(!stdout.text.includes(KEY) && !stderr.text.includes(KEY), 'API key leaked to output');
  return { code, stdout: stdout.text, stderr: stderr.text, json: stdout.text.startsWith('{') ? JSON.parse(stdout.text) : null };
};

const ops = () => calls.map((c) => c.query.match(/(?:query|mutation) (\w+)/)[1]);
const mutations = () => calls.filter((c) => c.query.startsWith('mutation'));

test('env reports set/missing without values', async () => {
  const { code, stdout } = await run(['env']);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { NEW_RELIC_API_KEY: 'set', NEW_RELIC_ACCOUNT_ID: 'set', NEW_RELIC_REGION: 'missing' });
});

test('the command must come first: options before plan/apply are refused before any file read or API call', async () => {
  writeWorkflow('demoWorkflow.yaml', VALID);
  const token = createToken(VALID);
  for (const argv of [['--expect', token, 'apply', 'demoWorkflow'], ['--account', '1234', 'plan', 'demoWorkflow'], ['--', 'apply', 'demoWorkflow']]) {
    const { code, stderr, stdout } = await run(argv);
    assert.equal(code, 1, argv.join(' '));
    assert.match(stderr, /Put the command first: node publish-workflow\.mjs/);
    assert.equal(stdout, '');
  }
  assert.equal(calls.length, 0);
});

test('plan: new name -> create with permanent-name warning, no mutation', async () => {
  writeWorkflow('demoWorkflow.yaml', VALID);
  const { code, json } = await run(['plan', 'demoWorkflow']);
  assert.equal(code, 0);
  assert.equal(json.action, 'create');
  assert.equal(json.name, 'demoWorkflow');
  assert.equal(json.accountId, 1234);
  assert.equal(json.publishable, true);
  assert.equal(json.nearMatches, undefined);
  assert.match(json.warnings[0], /Creates a NEW workflow; the name 'demoWorkflow' can never be changed/);
  assert.deepEqual(json.diffStats, { added: 10, removed: 0 });
  assert.equal(json.expect, createToken(VALID));
  assert.deepEqual(json.validation.summary, { errors: 0, warnings: 0, info: 0 });
  assert.deepEqual(ops(), ['ValidateWorkflow', 'ListWorkflows']);
});

test('plan: existing name -> update with diff, stats, nextVersion', async () => {
  writeWorkflow('demoWorkflow.yaml', EDITED);
  const respond = router({ published: { demoWorkflow: { 1: 'old', 2: VALID } } });
  const { code, json } = await run(['plan', 'workflows/demoWorkflow.yaml'], { respond });
  assert.equal(code, 0);
  assert.equal(json.action, 'update');
  assert.equal(json.currentVersion, 2);
  assert.equal(json.nextVersion, 3);
  assert.equal(json.unchanged, false);
  assert.deepEqual(json.diffStats, { added: 1, removed: 1 });
  assert.match(json.diff, /^--- demoWorkflow v2 \(New Relic\)\n\+\+\+ .*demoWorkflow\.yaml\n@@ -7,4 \+7,4 @@\n/);
  assert.match(json.diff, /\n-        - message: hello\n\+        - message: hello world\n/);
  assert.equal(json.diffTruncated, undefined);
  assert.equal(json.expect, updateToken(2, EDITED));
  assert.equal(calls.find((c) => c.query.includes('GetWorkflow')).variables.version, 2);
  assert.equal(mutations().length, 0);
});

test('plan: identical after CRLF and trailing-newline normalization -> unchanged', async () => {
  writeWorkflow('demoWorkflow.yaml', `${VALID.replace(/\n/g, '\r\n')}\r\n`);
  const respond = router({ published: { demoWorkflow: { 4: VALID.trimEnd() } } });
  const { code, json } = await run(['plan', 'demoWorkflow'], { respond });
  assert.equal(code, 0);
  assert.equal(json.unchanged, true);
  assert.equal(json.publishable, false);
  assert.equal(json.expect, undefined);
  assert.equal(json.diff, undefined);
  assert.deepEqual(json.diffStats, { added: 0, removed: 0 });
  assert.ok(json.warnings.some((w) => /nothing to publish/.test(w)));
});

test('plan: case-insensitive name match with no exact match -> conflict, not publishable', async () => {
  writeWorkflow('demoWorkflow.yaml', VALID);
  const respond = router({ published: { DemoWorkflow: { 1: VALID } } });
  const { code, json } = await run(['plan', 'demoWorkflow'], { respond });
  assert.equal(code, 0);
  assert.equal(json.action, 'conflict');
  assert.equal(json.name, 'demoWorkflow');
  assert.equal(json.existingName, 'DemoWorkflow');
  assert.deepEqual(json.nearMatches, ['DemoWorkflow']);
  assert.equal(json.publishable, false);
  assert.equal(json.expect, undefined);
  assert.deepEqual(json.warnings, [
    "A workflow named 'DemoWorkflow' already exists. Names are case-insensitive, so creating 'demoWorkflow' will fail. To update the existing workflow, change name: to exactly 'DemoWorkflow'.",
  ]);
  assert.deepEqual(ops(), ['ValidateWorkflow', 'ListWorkflows']);
});

test('plan: exact match wins over a case variant -> update', async () => {
  writeWorkflow('demoWorkflow.yaml', EDITED);
  const respond = router({ published: { DemoWorkflow: { 1: VALID }, demoWorkflow: { 2: VALID } } });
  const { json } = await run(['plan', 'demoWorkflow'], { respond });
  assert.equal(json.action, 'update');
  assert.equal(json.existingName, undefined);
});

test('plan: local validation errors exit 3 without list or mutation calls', async () => {
  writeWorkflow('bad.yaml', 'name: 1bad\nsteps: []\n');
  const { code, json } = await run(['plan', 'workflows/bad.yaml']);
  assert.equal(code, 3);
  assert.equal(json.publishable, false);
  assert.ok(json.validation.summary.errors > 0);
  assert.ok(!ops().includes('ListWorkflows'));
  assert.equal(mutations().length, 0);
});

test('plan: unparseable YAML exits 3 with no API calls', async () => {
  writeWorkflow('bad.yaml', 'name: wf\nsteps:\n  - name: a\n   type: wait\n');
  const { code, json } = await run(['plan', 'workflows/bad.yaml']);
  assert.equal(code, 3);
  assert.equal(json.validation.findings[0].category, 'yaml');
  assert.equal(calls.length, 0);
});

test('plan: server validation errors exit 3', async () => {
  writeWorkflow('demoWorkflow.yaml', VALID);
  const respond = router({ validate: { valid: false, errors: [{ message: 'unknown action' }] } });
  const { code, json } = await run(['plan', 'demoWorkflow'], { respond });
  assert.equal(code, 3);
  assert.deepEqual(json.validation.findings.map((f) => [f.category, f.message]), [['server', 'unknown action']]);
  assert.deepEqual(ops(), ['ValidateWorkflow']);
});

test('plan: missing API key is a usage error (no publish without server validation)', async () => {
  writeWorkflow('demoWorkflow.yaml', VALID);
  const { code, stderr, stdout } = await run(['plan', 'demoWorkflow'], { env: { NEW_RELIC_ACCOUNT_ID: '1234' } });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Server validation is required before publishing: NEW_RELIC_API_KEY is not set/);
  assert.equal(calls.length, 0);
});

test('plan: server unreachable is an API error', async () => {
  writeWorkflow('demoWorkflow.yaml', VALID);
  const { code, stderr } = await run(['plan', 'demoWorkflow'], { respond: () => ({ body: {}, status: 500 }) });
  assert.equal(code, 2);
  assert.match(stderr, /Server validation could not run .*HTTP 500.*Not publishing/);
  assert.deepEqual(ops(), ['ValidateWorkflow']);
});

test('plan: --stdin input works', async () => {
  const { code, json } = await run(['plan', '--stdin'], { stdin: Readable.from([VALID]) });
  assert.equal(code, 0);
  assert.equal(json.file, '<stdin>');
  assert.equal(json.action, 'create');
});

test('plan: rejects --expect and missing target', async () => {
  writeWorkflow('demoWorkflow.yaml', VALID);
  assert.equal((await run(['plan', 'demoWorkflow', '--expect', 'create'])).code, 1);
  assert.match((await run(['plan'])).stderr, /exactly one <file-or-name>/);
  assert.equal(calls.length, 0);
});

test('apply: missing, invalid, or bare create/update --expect is a usage error with no API calls', async () => {
  writeWorkflow('demoWorkflow.yaml', VALID);
  const bad = ['publish', 'create', 'update', 'update@2', `create#${sha12(VALID).slice(0, 8)}`, `update#${sha12(VALID)}`, `create@1#${sha12(VALID)}`];
  for (const argv of [['apply', 'demoWorkflow'], ...bad.map((expect) => ['apply', 'demoWorkflow', '--expect', expect])]) {
    const { code, stderr } = await run(argv);
    assert.equal(code, 1, argv.join(' '));
    assert.match(stderr, /apply requires --expect <token>: the exact "expect" value from plan .* A bare create or update is not accepted; run plan again/);
  }
  assert.equal(calls.length, 0);
});

test('apply: the token from plan publishes', async () => {
  writeWorkflow('demoWorkflow.yaml', EDITED);
  const respond = router({ published: { demoWorkflow: { 2: VALID } } });
  const { json: plan } = await run(['plan', 'demoWorkflow'], { respond });
  const { code, json } = await run(['apply', 'demoWorkflow', '--expect', plan.expect], { respond });
  assert.equal(code, 0);
  assert.equal(json.action, 'update');
  assert.equal(mutations().length, 1);
});

test('apply: refuses when the published version moved since plan', async () => {
  writeWorkflow('demoWorkflow.yaml', EDITED);
  const respond = router({ published: { demoWorkflow: { 2: VALID, 3: VALID } } });
  const { code, stderr, stdout } = await run(['apply', 'demoWorkflow', '--expect', updateToken(2, EDITED)], { respond });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Refusing to publish 'demoWorkflow': the latest published version moved from v2 to v3 \(someone published in the meantime\)\. Run plan again/);
  assert.equal(mutations().length, 0);
});

test('apply: refuses when the content changed since plan', async () => {
  writeWorkflow('demoWorkflow.yaml', `${VALID}# edited after plan\n`);
  const { code, stderr } = await run(['apply', 'demoWorkflow', '--expect', createToken(VALID)]);
  assert.equal(code, 1);
  assert.match(stderr, new RegExp(`the content to publish changed since plan, or the account or region differs from the plan \\(#${sha12(VALID)} -> #${sha12(`${VALID}# edited after plan\n`)}\\)`));
  assert.equal(mutations().length, 0);
});

test('plan: validation lists errors and warnings only; info findings are counted in the summary', async () => {
  writeWorkflow('demoWorkflow.yaml', VALID.replace('description: Logs a message\n', ''));
  const { code, json } = await run(['plan', 'demoWorkflow']);
  assert.equal(code, 0);
  assert.ok(json.validation.summary.info >= 1);
  assert.ok(json.validation.findings.every((f) => f.severity !== 'info'));
  assert.equal(json.validation.findings.length, json.validation.summary.errors + json.validation.summary.warnings);
});

test('apply: a token from plan for another account is refused with no mutation', async () => {
  writeWorkflow('demoWorkflow.yaml', EDITED);
  const respond = router({ published: { demoWorkflow: { 2: VALID } } });
  const { json: plan } = await run(['plan', 'demoWorkflow', '--account', '111'], { respond });
  assert.equal(plan.expect, updateToken(2, EDITED, 111));
  const { code, stderr, stdout } = await run(['apply', 'demoWorkflow', '--expect', plan.expect, '--account', '222'], { respond });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /the content to publish changed since plan, or the account or region differs/);
  assert.equal(mutations().length, 0);
  const create = await run(['apply', 'demoWorkflow', '--expect', createToken(VALID, 111), '--account', '222']);
  assert.equal(create.code, 1);
  assert.equal(mutations().length, 0);
});

test('apply: a token from plan for another region is refused with no mutation', async () => {
  writeWorkflow('demoWorkflow.yaml', VALID);
  const { json: plan } = await run(['plan', 'demoWorkflow']);
  assert.equal(plan.expect, createToken(VALID, 1234, 'US'));
  const { code, stderr } = await run(['apply', 'demoWorkflow', '--expect', plan.expect], { env: { ...env, NEW_RELIC_REGION: 'EU' } });
  assert.equal(code, 1);
  assert.match(stderr, /the account or region differs/);
  assert.equal(mutations().length, 0);
});

test('plan: a file that is not valid UTF-8 is refused before any API call', async () => {
  mkdirSync(join(cwd, 'workflows'), { recursive: true });
  writeFileSync(join(cwd, 'workflows', 'demoWorkflow.yaml'), Buffer.concat([Buffer.from(VALID.replace('hello', 'caf')), Buffer.from([0xe9]), Buffer.from('\n')]));
  const { code, stderr } = await run(['plan', 'demoWorkflow']);
  assert.equal(code, 1);
  assert.match(stderr, /demoWorkflow\.yaml is not valid UTF-8; re-save it as UTF-8/);
  assert.deepEqual(ops(), []);
  const viaStdin = await run(['plan', '--stdin'], { stdin: Readable.from([Buffer.from([0x6e, 0x3a, 0xe9])]) });
  assert.equal(viaStdin.code, 1);
  assert.match(viaStdin.stderr, /<stdin> is not valid UTF-8/);
});

test('apply: a UTF-8 file with a BOM and CRLF is published byte for byte', async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(VALID.replace(/\n/g, '\r\n'), 'utf8')]);
  mkdirSync(join(cwd, 'workflows'), { recursive: true });
  writeFileSync(join(cwd, 'workflows', 'demoWorkflow.yaml'), bytes);
  const { json: plan } = await run(['plan', 'demoWorkflow']);
  const rawHash = createHash('sha256').update(Buffer.concat([Buffer.from('1234\nUS\n'), bytes])).digest('hex').slice(0, 12);
  assert.equal(plan.expect, `create#${rawHash}`);
  const { code } = await run(['apply', 'demoWorkflow', '--expect', plan.expect]);
  assert.equal(code, 0);
  assert.deepEqual(Buffer.from(mutations()[0].variables.yaml, 'base64'), bytes);
});

test('apply: the hash covers raw bytes, so a CRLF-only change is refused', async () => {
  writeWorkflow('demoWorkflow.yaml', VALID.replace(/\n/g, '\r\n'));
  const { code, stderr } = await run(['apply', 'demoWorkflow', '--expect', createToken(VALID)]);
  assert.equal(code, 1);
  assert.match(stderr, /content to publish changed since plan/);
  assert.equal(mutations().length, 0);
});

test('apply: reports both a moved version and changed content', async () => {
  writeWorkflow('demoWorkflow.yaml', EDITED);
  const respond = router({ published: { demoWorkflow: { 3: VALID } } });
  const { code, stderr } = await run(['apply', 'demoWorkflow', '--expect', updateToken(2, VALID)], { respond });
  assert.equal(code, 1);
  assert.match(stderr, /moved from v2 to v3 .*; and the content to publish changed since plan/);
  assert.equal(mutations().length, 0);
});

test('apply: --expect mismatch refuses with no mutation', async () => {
  writeWorkflow('demoWorkflow.yaml', EDITED);
  const respond = router({ published: { demoWorkflow: { 2: VALID } } });
  const { code, stderr, stdout } = await run(['apply', 'demoWorkflow', '--expect', createToken(EDITED)], { respond });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Refusing to publish: --expect create#\w+ but .* UPDATE the existing workflow \(v2 -> v3\)/);
  assert.equal(mutations().length, 0);

  calls = [];
  const created = await run(['apply', 'demoWorkflow', '--expect', updateToken(2, EDITED)]);
  assert.equal(created.code, 1);
  assert.match(created.stderr, /--expect update@2#\w+ but .* CREATE a new workflow/);
  assert.equal(mutations().length, 0);
});

test('apply: conflict refuses with exit 1 and no mutation, for either --expect', async () => {
  writeWorkflow('demoWorkflow.yaml', VALID);
  const respond = router({ published: { DemoWorkflow: { 1: VALID } } });
  for (const expect of [createToken(VALID), updateToken(1, VALID)]) {
    const { code, stderr, stdout } = await run(['apply', 'demoWorkflow', '--expect', expect], { respond });
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, /Refusing to publish: A workflow named 'DemoWorkflow' already exists\. Names are case-insensitive, so creating 'demoWorkflow' will fail\. To update the existing workflow, change name: to exactly 'DemoWorkflow'\./);
  }
  assert.equal(mutations().length, 0);
});

test('apply: unchanged update refuses', async () => {
  writeWorkflow('demoWorkflow.yaml', VALID);
  const respond = router({ published: { demoWorkflow: { 2: VALID } } });
  const { code, stderr } = await run(['apply', 'demoWorkflow', '--expect', updateToken(2, VALID)], { respond });
  assert.equal(code, 1);
  assert.match(stderr, /identical to published version 2; nothing to publish/);
  assert.equal(mutations().length, 0);
});

test('apply: validation errors exit 3 with no mutation', async () => {
  writeWorkflow('bad.yaml', 'name: 1bad\nsteps: []\n');
  const { code } = await run(['apply', 'workflows/bad.yaml', '--expect', createToken('name: 1bad\nsteps: []\n')]);
  assert.equal(code, 3);
  assert.equal(mutations().length, 0);
});

test('apply: create sends scopeId as string and the exact file bytes as base64', async () => {
  const text = `# keep this comment\n${VALID}`;
  writeWorkflow('demoWorkflow.yaml', text);
  const { code, json } = await run(['apply', 'demoWorkflow', '--expect', createToken(text, 5678), '--account', '5678']);
  assert.equal(code, 0);
  assert.deepEqual(ops(), ['ValidateWorkflow', 'ListWorkflows', 'CreateWorkflow']);
  const [mutation] = mutations();
  assert.match(mutation.query, /workflowAutomationCreateWorkflowDefinition\(scope: \{id: \$scopeId, type: ACCOUNT\}, definition: \{yaml: \$yaml\}\)/);
  assert.deepEqual(Object.keys(mutation.variables).sort(), ['scopeId', 'yaml']);
  assert.equal(mutation.variables.scopeId, '5678');
  assert.equal(Buffer.from(mutation.variables.yaml, 'base64').toString('utf8'), text);
  assert.equal(calls.find((c) => c.query.includes('ListWorkflows')).variables.accountId, 5678);
  assert.equal(json.action, 'create');
  assert.equal(json.name, 'demoWorkflow');
  assert.equal(json.version, 1);
  assert.equal(json.definitionId, 'def-1');
  assert.equal(json.accountId, 5678);
  assert.match(json.hint, /run-workflow/);
});

test('apply: update calls UpdateWorkflow and reports the version', async () => {
  writeWorkflow('demoWorkflow.yaml', EDITED);
  const respond = router({ published: { demoWorkflow: { 1: 'old', 2: VALID } } });
  const { code, json } = await run(['apply', 'demoWorkflow', '--expect', updateToken(2, EDITED)], { respond });
  assert.equal(code, 0);
  assert.deepEqual(ops(), ['ValidateWorkflow', 'ListWorkflows', 'GetWorkflow', 'UpdateWorkflow']);
  const [mutation] = mutations();
  assert.match(mutation.query, /workflowAutomationUpdateWorkflowDefinition\(scope: \{id: \$scopeId, type: ACCOUNT\}/);
  assert.equal(mutation.variables.scopeId, '1234');
  assert.equal(Buffer.from(mutation.variables.yaml, 'base64').toString('utf8'), EDITED);
  assert.deepEqual({ action: json.action, version: json.version, accountId: json.accountId }, { action: 'update', version: 3, accountId: 1234 });
});

test('apply: GraphQL error on the mutation exits 2 and never leaks the key', async () => {
  writeWorkflow('demoWorkflow.yaml', VALID);
  const respond = router({ mutation: { body: { errors: [{ message: `Workflow already exists (key ${KEY})` }] } } });
  const { code, stderr, stdout } = await run(['apply', 'demoWorkflow', '--expect', createToken(VALID)], { respond });
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /NerdGraph error: Workflow already exists \(key \[REDACTED\]\)/);
});

test('apply: --stdin input works', async () => {
  const { code, json } = await run(['apply', '--stdin', '--expect', createToken(VALID)], { stdin: Readable.from([VALID]) });
  assert.equal(code, 0);
  assert.equal(json.version, 1);
  assert.equal(Buffer.from(mutations()[0].variables.yaml, 'base64').toString('utf8'), VALID);
});

test('unifiedDiff: hunks with 3 lines of context, separate hunks, and truncation', () => {
  const old = Array.from({ length: 30 }, (_, i) => `line${i + 1}`).join('\n');
  const next = old.replace('line2\n', 'line2x\n').replace('line25\n', '');
  const { diff, stats, truncated } = unifiedDiff(old, next, { oldLabel: 'old', newLabel: 'new' });
  assert.deepEqual(stats, { added: 1, removed: 2 });
  assert.equal(truncated, false);
  assert.deepEqual(diff.split('\n').filter((l) => l.startsWith('@@')), ['@@ -1,5 +1,5 @@', '@@ -22,7 +22,6 @@']);

  const big = unifiedDiff('', Array.from({ length: 1000 }, (_, i) => `x${i}`).join('\n'));
  assert.equal(big.truncated, true);
  assert.equal(big.diff.trimEnd().split('\n').length, 400);
  assert.deepEqual(big.stats, { added: 1000, removed: 0 });
  assert.deepEqual(unifiedDiff('a\r\nb\r\n', 'a\nb').stats, { added: 0, removed: 0 });
});

test('plan: plaintext secrets in the published version are redacted from the diff', async () => {
  const token = `NRAK-${'A'.repeat(27)}`;
  const published = VALID.replace('    inputs:\n', `    inputs:\n      apiKey: ${token}\n      password: hunter2\n`);
  const local = VALID.replace('    inputs:\n', '    inputs:\n      apiKey: ${{ :secrets:NR_KEY }}\n');
  writeWorkflow('demoWorkflow.yaml', local);
  const respond = router({ published: { demoWorkflow: { 1: published } } });
  const { code, json, stdout } = await run(['plan', 'demoWorkflow'], { respond });
  assert.equal(code, 0);
  assert.ok(!stdout.includes(token) && !stdout.includes('hunter2'));
  assert.match(json.diff, /-      apiKey: NRAK…\[REDACTED\]\n-      password: \[REDACTED\]\n\+      apiKey: \$\{\{ :secrets:NR_KEY \}\}\n/);
  assert.ok(json.warnings.some((w) => /redacted from the diff/.test(w)));
});

test('redactDiff: case-insensitive token patterns keep their flags (lowercase NRAK body is redacted)', () => {
  const lower = `NRAK-${'a'.repeat(27)}`;
  const out = redactDiff(`-      note: ${lower}`, KEY);
  assert.equal(out.diff, '-      note: NRAK…[REDACTED]');
  assert.equal(out.redacted, true);
});

test('redactDiff: block scalars under sensitive keys, hyphenated and webhook keys', () => {
  const diff = [
    '@@ -1,9 +1,6 @@',
    '       privateKey: |',
    '-        -----BEGIN KEY-----',
    '-        c2VjcmV0LWJsb2Nr',
    '+        bmV3LXNlY3JldA==',
    '       next: step2',
    '-      X-Api-Key: abcd1234efgh5678',
    '-      webhookUrl: https://example.com/hooks/abc',
    '+      script: |',
    '+        echo hi',
  ].join('\n');
  const { diff: out, redacted } = redactDiff(diff);
  assert.equal(redacted, true);
  assert.deepEqual(out.split('\n'), [
    '@@ -1,9 +1,6 @@',
    '       privateKey: |',
    '-        [REDACTED]',
    '-        [REDACTED]',
    '+        [REDACTED]',
    '       next: step2',
    '-      X-Api-Key: [REDACTED]',
    '-      webhookUrl: [REDACTED]',
    '+      script: |',
    '+        echo hi',
  ]);
});

test('redactDiff: a block scalar ends at the first line not indented deeper than its key', () => {
  const diff = ['@@ -1,4 +1,4 @@', '-  - password: >-', '-      folded secret', '-    other: visible', '+  - name: x'].join('\n');
  assert.deepEqual(redactDiff(diff).diff.split('\n'), ['@@ -1,4 +1,4 @@', '-  - password: >-', '-      [REDACTED]', '-    other: visible', '+  - name: x']);
});

test('redactDiff: flow mappings and JSON strings redact only the sensitive values', () => {
  const diff = [
    '@@ -1,3 +1,3 @@',
    '-      headers: {Authorization: Basic abc123, Accept: json}',
    '-      headers: \'{"X-Api-Key": "zzz999", "Accept": "json"}\'',
    '+      x: 1',
  ].join('\n');
  const { diff: out, redacted } = redactDiff(diff);
  assert.equal(redacted, true);
  assert.deepEqual(out.split('\n'), [
    '@@ -1,3 +1,3 @@',
    '-      headers: {Authorization: [REDACTED], Accept: json}',
    '-      headers: \'{"X-Api-Key": [REDACTED], "Accept": "json"}\'',
    '+      x: 1',
  ]);
});

test('redactDiff: a sensitive key with no inline value redacts the lines nested under it', () => {
  const diff = ['@@ -1,4 +1,2 @@', '-      password:', '-        hunter2', '-      next: step', '+      other: 1'].join('\n');
  const { diff: out, redacted } = redactDiff(diff);
  assert.equal(redacted, true);
  assert.deepEqual(out.split('\n'), ['@@ -1,4 +1,2 @@', '-      password:', '-        [REDACTED]', '-      next: step', '+      other: 1']);
});

test('unifiedDiff maskSecrets: a hunk that starts inside a sensitive block scalar is still masked', () => {
  const body = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].map((l) => `  secret-${l}`);
  const oldText = ['privateKey: |', ...body, 'after: x'].join('\n');
  const newText = oldText.replace('secret-l7', 'secret-changed');
  const leaky = unifiedDiff(oldText, newText);
  assert.match(leaky.diff, /secret-l5/);
  const masked = unifiedDiff(oldText, newText, { maskSecrets: true });
  assert.equal(masked.redacted, true);
  assert.doesNotMatch(masked.diff, /secret-/);
  assert.match(masked.diff, /^-  \[REDACTED\]$/m);
  assert.match(masked.diff, /^\+  \[REDACTED\]$/m);
  assert.match(masked.diff, /^ after: x$/m);
});

test('unifiedDiff maskSecrets: a changed secret still shows as a removed and an added line', () => {
  const { diff, redacted } = unifiedDiff('password: |\n  old-secret', 'password: |\n  new-secret', { maskSecrets: true });
  assert.equal(redacted, true);
  assert.deepEqual(diff.split('\n').slice(2), ['@@ -1,2 +1,2 @@', ' password: |', '-  [REDACTED]', '+  [REDACTED]', '']);
});

test('plan: update diff masks a block nested under a sensitive key whose key line is outside the hunk, and warns', async () => {
  const nested = Array.from({ length: 8 }, (_, i) => `        k${i + 1}: secretline${i + 1}`).join('\n');
  const published = VALID.replace('    inputs:\n', `    inputs:\n      credentials:\n${nested}\n`);
  const edited = published.replace('secretline8', 'secretline-new');
  writeWorkflow('demoWorkflow.yaml', edited);
  const { code, json } = await run(['plan', 'demoWorkflow'], { respond: router({ published: { demoWorkflow: { 2: published } } }) });
  assert.equal(code, 0);
  assert.doesNotMatch(json.diff, /secretline/);
  assert.match(json.diff, /^-        \[REDACTED\]$/m);
  assert.ok(json.warnings.some((w) => /redacted from the diff/.test(w)));
});
