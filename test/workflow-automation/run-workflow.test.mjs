import { test, beforeEach } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../skills/workflow-automation/run-workflow/scripts/run-workflow.mjs';

const KEY = 'NRAK-SECRETKEY123';
const env = { NEW_RELIC_API_KEY: KEY, NEW_RELIC_ACCOUNT_ID: '1234' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GIVEN_KEY = '6f1c2a5e-8d3b-4c7a-9e21-0b4d5f6a7c8d';
// Independent re-implementation of the plan's expect token: <name>@<version>#sha12({inputs: sorted [key, wire], logLevel, accountId, region}).
const token = (name, version, inputs = [], logLevel = null, accountId = 1234, region = 'US') => {
  const sorted = [...inputs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${name}@${version}#${createHash('sha256').update(JSON.stringify({ inputs: sorted, logLevel, accountId, region })).digest('hex').slice(0, 12)}`;
};
const HI2 = token('demoWorkflow', 2, [['message', 'hi']]);

const VALID = `name: demoWorkflow
description: Logs a message
workflowInputs:
  message:
    type: String
  count:
    type: Int
    defaultValue: 1
  tags:
    type: List
    required: false
steps:
  - name: sendLog
    type: action
    action: newrelic.ingest.sendLogs
    version: 1
    inputs:
      logs:
        - message: \${{ .workflowInputs.message }}
`;
const EDITED = VALID.replace('description: Logs a message', 'description: Logs a message twice');

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const wa = (inner) => ({ data: { actor: { account: { workflowAutomation: inner } } } });
const runInfo = (status) => ({ body: wa({ workflowRunInfo: { status, logUrl: 'https://one.newrelic.com/logs/run-1', state: [{ key: 'k', value: 'v' }] } }) });

// Routes on the operation name; `published` is the account's workflows: {name: {version: yaml}}. `info` is a queue of
// WorkflowRunInfo responses (the last one repeats).
function router({ published = { demoWorkflow: { 1: 'old', 2: VALID } }, mutation, info = [runInfo('RUNNING')] } = {}) {
  const queue = [...info];
  return ({ query, variables }) => {
    if (query.includes('ListWorkflows')) {
      const results = Object.entries(published).flatMap(([name, versions]) => Object.keys(versions).map((v) => ({ definition: { name, version: Number(v) } })));
      return { body: wa({ workflows: { nextCursor: null, results } }) };
    }
    if (query.includes('GetWorkflow')) {
      const yaml = published[variables.name]?.[variables.version];
      return { body: wa({ workflow: yaml ? { definition: { name: variables.name, version: variables.version, yaml: b64(yaml) } } : null }) };
    }
    if (query.includes('mutation StartWorkflowRun')) return mutation ?? { body: { data: { workflowAutomationStartWorkflowRun: { runId: 'run-1' } } } };
    if (query.includes('WorkflowRunInfo')) return queue.length > 1 ? queue.shift() : queue[0];
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
let sleeps;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'run-wf-'));
  calls = [];
  sleeps = [];
});

const writeWorkflow = (file, text) => {
  mkdirSync(join(cwd, 'workflows'), { recursive: true });
  writeFileSync(join(cwd, 'workflows', file), text);
};

const run = async (argv, { respond = router(), ...extra } = {}) => {
  const stdout = capture();
  const stderr = capture();
  const sleep = async (ms) => { sleeps.push(ms); };
  const code = await main(argv, { env, stdout, stderr, cwd, fetchImpl: fakeFetch(calls, respond), sleep, ...extra });
  assert.ok(!stdout.text.includes(KEY) && !stderr.text.includes(KEY), 'API key leaked to output');
  return { code, stdout: stdout.text, stderr: stderr.text, json: stdout.text.startsWith('{') ? JSON.parse(stdout.text) : null };
};

const ops = () => calls.map((c) => c.query.match(/(?:query|mutation) (\w+)/)[1]);
const mutations = () => calls.filter((c) => c.query.startsWith('mutation'));

test('env reports set/missing without values, plus the temp dir', async () => {
  const { code, json } = await run(['env']);
  assert.equal(code, 0);
  assert.deepEqual(json, { NEW_RELIC_API_KEY: 'set', NEW_RELIC_ACCOUNT_ID: 'set', NEW_RELIC_REGION: 'missing', tmpDir: tmpdir() });
});

test('the command must come first: options before plan/start are refused before any API call', async () => {
  for (const argv of [['--expect', HI2, 'start', 'demoWorkflow'], ['--input', 'message=hi', 'plan', 'demoWorkflow'], ['--', 'start', 'demoWorkflow']]) {
    const { code, stderr, stdout } = await run(argv);
    assert.equal(code, 1, argv.join(' '));
    assert.match(stderr, /Put the command first: node run-workflow\.mjs/);
    assert.equal(stdout, '');
  }
  assert.equal(calls.length, 0);
  assert.equal(mutations().length, 0);
});

test('plan by name: latest version, inputs with sources, summary, expect; read-only', async () => {
  const { code, json } = await run(['plan', 'demoWorkflow', '--input', 'message=hello']);
  assert.equal(code, 0);
  assert.equal(json.action, undefined);
  assert.equal(json.file, undefined);
  assert.equal(json.localDiffers, undefined);
  assert.deepEqual({ name: json.name, version: json.version, latestVersion: json.latestVersion, accountId: json.accountId }, { name: 'demoWorkflow', version: 2, latestVersion: 2, accountId: 1234 });
  assert.deepEqual(json.inputs, [{ key: 'message', value: 'hello', source: 'supplied' }, { key: 'count', value: 1, source: 'default' }]);
  assert.deepEqual(json.declaredInputs, ['message', 'count', 'tags']);
  assert.deepEqual({ steps: json.steps, actions: json.actions, description: json.description }, { steps: 1, actions: ['newrelic.ingest.sendLogs'], description: 'Logs a message' });
  assert.equal(json.logLevel, null);
  assert.equal(json.startable, true);
  assert.equal(json.expect, token('demoWorkflow', 2, [['message', 'hello']]));
  assert.equal(json.hint, undefined);
  assert.deepEqual(ops(), ['ListWorkflows', 'GetWorkflow']);
  assert.equal(calls[1].variables.version, 2);
  assert.equal(sleeps.length, 0);
});

test('plan by local file: reads name:, localDiffers false when identical (CRLF-normalized)', async () => {
  writeWorkflow('demo.yaml', `${VALID.replace(/\n/g, '\r\n')}\r\n`);
  const { code, json } = await run(['plan', 'workflows/demo.yaml', '--input', 'message=hi']);
  assert.equal(code, 0);
  assert.match(json.file, /workflows\/demo\.yaml$/);
  assert.equal(json.name, 'demoWorkflow');
  assert.equal(json.localDiffers, false);
  assert.deepEqual(json.warnings, []);
});

test('plan: local file that differs from the published version -> localDiffers warning', async () => {
  writeWorkflow('demoWorkflow.yaml', EDITED);
  const { code, json } = await run(['plan', 'demoWorkflow', '--input', 'message=hi']);
  assert.equal(code, 0);
  assert.equal(json.localDiffers, true);
  assert.match(json.warnings[0], /PUBLISHED version runs, not the local edits; publish first/);
  assert.equal(json.startable, true);
});

test('plan: --version pins an older version and warns', async () => {
  const respond = router({ published: { demoWorkflow: { 1: VALID, 2: VALID } } });
  const { code, json } = await run(['plan', 'demoWorkflow', '--version', '1', '--input', 'message=hi'], { respond });
  assert.equal(code, 0);
  assert.equal(json.version, 1);
  assert.equal(json.expect, token('demoWorkflow', 1, [['message', 'hi']]));
  assert.match(json.warnings[0], /not the latest published version \(2\)/);
  assert.equal(calls.find((c) => c.query.includes('GetWorkflow')).variables.version, 1);

  const missing = await run(['plan', 'demoWorkflow', '--version', '9'], { respond });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no version 9 .*published versions: 1, 2/);
});

test('plan: the step and action summary includes steps inside loops, and a published YAML that does not parse is an API error', async () => {
  const looped = VALID.replace(/steps:\n[\s\S]*$/, `steps:
  - name: each
    type: loop
    for:
      in: \${{ [1, 2] }}
      steps:
        - name: sendLog
          type: action
          action: newrelic.ingest.sendLogs
          version: 1
          inputs:
            logs:
              - message: hi
        - name: pause
          type: wait
          seconds: 1
`);
  const { code, json } = await run(['plan', 'demoWorkflow', '--input', 'message=hi'], { respond: router({ published: { demoWorkflow: { 2: looped } } }) });
  assert.equal(code, 0);
  assert.equal(json.steps, 3);
  assert.deepEqual(json.actions, ['newrelic.ingest.sendLogs']);
  const broken = await run(['plan', 'demoWorkflow'], { respond: router({ published: { demoWorkflow: { 2: 'name: [unclosed' } } }) });
  assert.equal(broken.code, 2);
  assert.match(broken.stderr, /Published workflow "demoWorkflow" version 2 could not be parsed as YAML/);
});

test('plan: unpublished name -> exit 2 with a publish hint', async () => {
  const { code, stderr, stdout } = await run(['plan', 'otherWorkflow']);
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /No published workflow named 'otherWorkflow' in account 1234\. Publish it first with the publish-workflow skill/);
});

test('plan: case-only match is refused (exit 1)', async () => {
  const { code, stderr } = await run(['plan', 'DemoWorkflow']);
  assert.equal(code, 1);
  assert.match(stderr, /Refusing to run: no workflow named 'DemoWorkflow' .* but 'demoWorkflow' exists/);
  assert.deepEqual(ops(), ['ListWorkflows']);
});

test('plan: a local file without a valid name: explains that it shadows the published name', async () => {
  writeWorkflow('demoWorkflow.yaml', 'steps: []\n');
  const byName = await run(['plan', 'demoWorkflow']);
  assert.equal(byName.code, 1);
  assert.match(byName.stderr, /demoWorkflow\.yaml matches "demoWorkflow" but has no valid top-level "name:"/);
  assert.match(byName.stderr, /move or rename it to run the published workflow of that name/);
  assert.doesNotMatch(byName.stderr, /or pass the workflow name/);
  const byPath = await run(['plan', 'workflows/demoWorkflow.yaml']);
  assert.equal(byPath.code, 1);
  assert.match(byPath.stderr, /demoWorkflow\.yaml has no valid top-level "name:"; run the validate-workflow skill on it\./);
  assert.doesNotMatch(byPath.stderr, /move or rename/);
  assert.deepEqual(ops(), []);
});

test('plan and start refuse a token passed as a run input, without echoing it', async () => {
  const nrak = `NRAK-${'B'.repeat(27)}`;
  const plan = await run(['plan', 'demoWorkflow', '--input', `message=${nrak}`]);
  assert.equal(plan.code, 3);
  assert.equal(plan.json.startable, false);
  assert.equal(plan.json.expect, undefined);
  assert.ok(plan.json.findings.some((f) => f.ruleId === 'input-plaintext-token'));
  assert.ok(!plan.stdout.includes(nrak) && !plan.stderr.includes(nrak));
  const start = await run(['start', 'demoWorkflow', '--expect', token('demoWorkflow', 2, [['message', nrak]]), '--input', `message=${nrak}`]);
  assert.equal(start.code, 3);
  assert.ok(!start.stdout.includes(nrak) && !start.stderr.includes(nrak));
  assert.equal(mutations().length, 0);
});

test('plan: input errors exit 3, not startable, no expect', async () => {
  const { code, json } = await run(['plan', 'demoWorkflow', '--input', 'count=abc', '--input', 'bogus=1']);
  assert.equal(code, 3);
  assert.equal(json.startable, false);
  assert.equal(json.expect, undefined);
  assert.deepEqual(json.findings.map((f) => [f.ruleId, f.path]), [['unknown-input', 'bogus'], ['missing-input', 'message'], ['input-type', 'count']]);
});

test('plan: usage errors before any API call', async () => {
  for (const argv of [
    ['plan'],
    ['plan', 'demoWorkflow', '--expect', 'demoWorkflow@2'],
    ['plan', 'demoWorkflow', '--version', 'latest'],
    ['plan', 'demoWorkflow', '--log-level', 'LOUD'],
    ['plan', 'demoWorkflow', '--input', 'novalue'],
    ['plan', 'demoWorkflow', '--inputs-json', '[]'],
    ['plan', 'bad name!'],
    ['plan', 'workflows/missing.yaml'],
  ]) {
    assert.equal((await run(argv)).code, 1, argv.join(' '));
  }
  assert.equal(calls.length, 0);
});

test('start: requires a well-formed --expect and a UUID --idempotency-key', async () => {
  for (const argv of [
    ['start', 'demoWorkflow'],
    ['start', 'demoWorkflow', '--expect', 'demoWorkflow'],
    ['start', 'demoWorkflow', '--expect', 'demoWorkflow@2', '--input', 'message=hi'],
    ['start', 'demoWorkflow', '--expect', `${HI2.slice(0, -1)}`, '--input', 'message=hi'],
  ]) {
    const { code, stderr } = await run(argv);
    assert.equal(code, 1, argv.join(' '));
    assert.match(stderr, /start requires --expect <name>@<version>#<inputsHash>: .* A bare <name>@<version> is not accepted; run plan again/);
  }
  {
    const { code, stderr } = await run(['start', 'demoWorkflow', '--expect', HI2, '--input', 'message=hi', '--idempotency-key', 'not-a-uuid']);
    assert.equal(code, 1);
    assert.match(stderr, /must be a UUID/);
  }
  assert.equal(calls.length, 0);
});

test('start: --expect mismatch (name or version changed since plan) refuses with no mutation', async () => {
  // The user confirmed v2, but v3 was published meanwhile.
  const respond = router({ published: { demoWorkflow: { 2: VALID, 3: EDITED } } });
  const { code, stderr, stdout } = await run(['start', 'demoWorkflow', '--expect', HI2, '--input', 'message=hi'], { respond });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Refusing to start: --expect demoWorkflow@2#\w+ but it would run demoWorkflow@3 \(plan now gives demoWorkflow@3#\w+\)\. Run plan again/);
  assert.equal(mutations().length, 0);

  assert.equal((await run(['start', 'demoWorkflow', '--expect', token('otherWorkflow', 2, [['message', 'hi']]), '--input', 'message=hi'])).code, 1);
  assert.equal(mutations().length, 0);
});

test('start: a token from plan for another account or region is refused with no mutation', async () => {
  const { json: plan } = await run(['plan', 'demoWorkflow', '--input', 'message=hi', '--account', '111']);
  assert.equal(plan.expect, token('demoWorkflow', 2, [['message', 'hi']], null, 111));
  const other = await run(['start', 'demoWorkflow', '--expect', plan.expect, '--input', 'message=hi', '--account', '222']);
  assert.equal(other.code, 1);
  assert.match(other.stderr, /Refusing to start: .* but the inputs, log level, account, or region differ from the plan the user confirmed/);
  const eu = await run(['start', 'demoWorkflow', '--expect', HI2, '--input', 'message=hi'], { env: { ...env, NEW_RELIC_REGION: 'EU' } });
  assert.equal(eu.code, 1);
  assert.match(eu.stderr, /account, or region differ/);
  assert.equal(mutations().length, 0);
});

test('start: inputs or log level changed since plan refuses with no mutation', async () => {
  for (const extra of [['--input', 'message=bye'], ['--input', 'message=hi', '--log-level', 'DEBUG'], ['--input', 'message=hi', '--input', 'count=2']]) {
    const { code, stderr } = await run(['start', 'demoWorkflow', '--expect', HI2, ...extra]);
    assert.equal(code, 1, extra.join(' '));
    assert.match(stderr, /Refusing to start: .* but the inputs, log level, account, or region differ from the plan the user confirmed/);
  }
  const both = await run(['start', 'demoWorkflow', '--expect', HI2, '--input', 'message=bye'], { respond: router({ published: { demoWorkflow: { 2: VALID, 3: VALID } } }) });
  assert.match(both.stderr, /it would run demoWorkflow@3, and the inputs, log level, account, or region differ/);
  assert.equal(mutations().length, 0);
});

test('start: the inputs hash ignores argument order and the way inputs were given', async () => {
  const a = await run(['plan', 'demoWorkflow', '--input', 'message=hi', '--input', 'count=2']);
  const b = await run(['plan', 'demoWorkflow', '--inputs-json', '{"count": 2, "message": "hi"}']);
  assert.equal(a.json.expect, b.json.expect);
  assert.equal(a.json.expect, token('demoWorkflow', 2, [['message', 'hi'], ['count', '2']]));
  const { code } = await run(['start', 'demoWorkflow', '--expect', a.json.expect, '--inputs-json', '{"message": "hi", "count": 2}']);
  assert.equal(code, 0);
  assert.equal(mutations().length, 1);
});

test('--inputs-file: inputs from a JSON file hash the same as other forms; a changed file refuses start', async () => {
  const a = await run(['plan', 'demoWorkflow', '--input', 'message=hi', '--input', 'count=2']);
  writeFileSync(join(cwd, 'inputs.json'), '{"count": 2, "message": "hi"}');
  const b = await run(['plan', 'demoWorkflow', '--inputs-file', 'inputs.json']);
  assert.equal(b.code, 0);
  assert.equal(b.json.expect, a.json.expect);
  writeFileSync(join(cwd, 'inputs.json'), '{"count": 3, "message": "hi"}');
  const changed = await run(['start', 'demoWorkflow', '--expect', a.json.expect, '--inputs-file', 'inputs.json']);
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /the inputs, log level, account, or region differ from the plan the user confirmed/);
  assert.equal(mutations().length, 0);
  writeFileSync(join(cwd, 'inputs.json'), '{"count": 2}');
  const { code } = await run(['start', 'demoWorkflow', '--expect', a.json.expect, '--inputs-file', 'inputs.json', '--input', 'message=hi']);
  assert.equal(code, 0);
  assert.equal(mutations().length, 1);
});

test('--inputs-file: missing, invalid, non-object, or duplicate keys are usage errors before any API call', async () => {
  writeFileSync(join(cwd, 'bad.json'), '{nope');
  writeFileSync(join(cwd, 'list.json'), '[1]');
  writeFileSync(join(cwd, 'dup.json'), '{"message": "hi"}');
  const cases = [
    [['--inputs-file', 'missing.json'], /--inputs-file not found/],
    [['--inputs-file', 'bad.json'], /--inputs-file .*bad\.json is not valid JSON/],
    [['--inputs-file', 'list.json'], /must be a JSON object/],
    [['--inputs-file', 'dup.json', '--input', 'message=hi'], /Input "message" is given more than once/],
  ];
  for (const [extra, pattern] of cases) {
    const { code, stderr } = await run(['plan', 'demoWorkflow', ...extra]);
    assert.equal(code, 1, extra.join(' '));
    assert.match(stderr, pattern);
  }
  assert.equal(calls.length, 0);
});

test('start: input errors exit 3 with no mutation', async () => {
  const { code, json } = await run(['start', 'demoWorkflow', '--expect', token('demoWorkflow', 2)]);
  assert.equal(code, 3);
  assert.equal(json.startable, false);
  assert.equal(mutations().length, 0);
});

test('start: mutation variables (string scope id, string values, UUID key, pinned version), then RUNNING', async () => {
  const argv = ['start', 'demoWorkflow', '--expect', token('demoWorkflow', 2, [['message', 'hi'], ['tags', '["a","b"]']], 'DEBUG', 5678), '--account', '5678', '--input', 'message=hi', '--inputs-json', '{"tags": ["a", "b"]}', '--log-level', 'debug'];
  const { code, json } = await run(argv);
  assert.equal(code, 0);
  assert.deepEqual(ops(), ['ListWorkflows', 'GetWorkflow', 'StartWorkflowRun', 'WorkflowRunInfo']);
  const [mutation] = mutations();
  assert.match(mutation.query, /workflowAutomationStartWorkflowRun\(scope: \{id: \$scopeId, type: ACCOUNT\}, definition: \{name: \$name, version: \$version\}/);
  const { idempotencyKey, ...rest } = mutation.variables;
  assert.match(idempotencyKey, UUID);
  assert.deepEqual(rest, {
    scopeId: '5678',
    name: 'demoWorkflow',
    version: 2,
    workflowInputs: [{ key: 'message', value: 'hi' }, { key: 'tags', value: '["a","b"]' }],
    options: { logLevel: 'DEBUG' },
  });
  assert.deepEqual(calls.at(-1).variables, { accountId: 5678, runId: 'run-1' });
  assert.deepEqual(sleeps, [15_000]);
  assert.deepEqual(json, {
    runId: 'run-1',
    idempotencyKey,
    name: 'demoWorkflow',
    version: 2,
    accountId: 5678,
    started: true,
    status: 'RUNNING',
    logUrl: 'https://one.newrelic.com/logs/run-1',
    hint: json.hint,
  });
  assert.match(json.hint, /do not wait or poll.*status run-1/);
});

test('start: no supplied inputs and no log level send null, and a given key is used', async () => {
  const respond = router({ published: { demoWorkflow: { 2: 'name: demoWorkflow\nsteps:\n  - name: w\n    type: wait\n    seconds: 1\n' } } });
  const { code, json } = await run(['start', 'demoWorkflow', '--expect', token('demoWorkflow', 2), '--idempotency-key', GIVEN_KEY], { respond });
  assert.equal(code, 0);
  const [mutation] = mutations();
  assert.equal(mutation.variables.workflowInputs, null);
  assert.equal(mutation.variables.options, null);
  assert.equal(mutation.variables.idempotencyKey, GIVEN_KEY);
  assert.equal(json.idempotencyKey, GIVEN_KEY);
});

test('start: COMPLETED exits 0; FAILED and TIMED_OUT exit 4 with the logUrl', async () => {
  for (const [status, exit] of [['COMPLETED', 0], ['FAILED', 4], ['TIMED_OUT', 4]]) {
    const { code, json } = await run(['start', 'demoWorkflow', '--expect', HI2, '--input', 'message=hi'], { respond: router({ info: [runInfo(status)] }) });
    assert.equal(code, exit, status);
    assert.equal(json.status, status);
    assert.equal(json.logUrl, 'https://one.newrelic.com/logs/run-1');
  }
});

test('start: run info retried once after an error, then reported', async () => {
  const respond = router({ info: [{ body: { errors: [{ message: 'run not found yet' }] } }, runInfo('RUNNING')] });
  const { code, json } = await run(['start', 'demoWorkflow', '--expect', HI2, '--input', 'message=hi'], { respond });
  assert.equal(code, 0);
  assert.equal(json.status, 'RUNNING');
  assert.deepEqual(sleeps, [15_000, 15_000]);
  assert.equal(ops().filter((op) => op === 'WorkflowRunInfo').length, 2);
});

test('start: run info still unavailable after the retry -> UNKNOWN, exit 0, status hint', async () => {
  const respond = router({ info: [{ body: wa({ workflowRunInfo: null }) }] });
  const { code, json } = await run(['start', 'demoWorkflow', '--expect', HI2, '--input', 'message=hi'], { respond });
  assert.equal(code, 0);
  assert.equal(json.started, true);
  assert.equal(json.status, 'UNKNOWN');
  assert.equal(json.logUrl, null);
  assert.match(json.hint, /status run-1/);
  assert.deepEqual(sleeps, [15_000, 15_000]);
});

test('start: mutation error exits 2, keeps the idempotency key, and never leaks the API key', async () => {
  const respond = router({ mutation: { body: { errors: [{ message: `Workflow run failed to start (key ${KEY})` }] } } });
  const { code, stderr, stdout } = await run(['start', 'demoWorkflow', '--expect', HI2, '--input', 'message=hi', '--idempotency-key', GIVEN_KEY], { respond });
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /NerdGraph error: Workflow run failed to start \(key \[REDACTED\]\)/);
  assert.match(stderr, new RegExp(`--idempotency-key ${GIVEN_KEY} is safe`));
  assert.equal(sleeps.length, 0);
});

test('status: one read-only call, exit 0 for RUNNING and 4 for FAILED', async () => {
  const { code, json } = await run(['status', 'run-1']);
  assert.equal(code, 0);
  assert.deepEqual(json, { runId: 'run-1', accountId: 1234, status: 'RUNNING', logUrl: 'https://one.newrelic.com/logs/run-1', state: [{ key: 'k', value: 'v' }] });
  assert.deepEqual(ops(), ['WorkflowRunInfo']);
  assert.equal(sleeps.length, 0);

  assert.equal((await run(['status', 'run-1'], { respond: router({ info: [runInfo('FAILED')] }) })).code, 4);
  const missing = await run(['status', 'run-2'], { respond: router({ info: [{ body: wa({ workflowRunInfo: null }) }] }) });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /No workflow run "run-2" found in account 1234/);
  assert.equal((await run(['status'])).code, 1);
});

test('status: state is capped at 20 entries and 200 chars per value, and flagged', async () => {
  const state = Array.from({ length: 25 }, (_, i) => ({ key: `k${i}`, value: i === 0 ? 'x'.repeat(5000) : 'v' }));
  const info = { body: wa({ workflowRunInfo: { status: 'COMPLETED', logUrl: 'https://one.newrelic.com/logs/run-1', state } }) };
  const { code, json } = await run(['status', 'run-1'], { respond: router({ info: [info] }) });
  assert.equal(code, 0);
  assert.equal(json.state.length, 20);
  assert.equal(json.stateTruncated, true);
  assert.equal(json.state[0].value, `${'x'.repeat(200)}… (+4800 chars)`);
  assert.deepEqual(json.state[1], { key: 'k1', value: 'v' });
});

test('missing API key is a usage error with no API call', async () => {
  const { code, stderr } = await run(['plan', 'demoWorkflow'], { env: { NEW_RELIC_ACCOUNT_ID: '1234' } });
  assert.equal(code, 1);
  assert.match(stderr, /NEW_RELIC_API_KEY is not set/);
  assert.equal(calls.length, 0);
});
