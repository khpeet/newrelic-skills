// Security hardening: bounded regex scans, bounded untrusted text, write safety, stderr sanitizing.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportError } from '../../shared/workflow-automation/cli.mjs';
import { checkRunInputs } from '../../shared/workflow-automation/inputs.mjs';
import { UsageError, getConfig } from '../../shared/workflow-automation/nerdgraph.mjs';
import { assertInsideCwd, assertNoSymlinks } from '../../shared/workflow-automation/paths.mjs';
import { MAX_UNTRUSTED_CHARS, stripControlChars, truncate } from '../../shared/workflow-automation/text.mjs';
import { MAX_SCAN_CHARS, TOKEN_PATTERNS, findToken, scanSecrets, validateLocal } from '../../shared/workflow-automation/validation.mjs';
import { writeNoOverwrite } from '../../shared/workflow-automation/workflows.mjs';
import { describeAction, listActions, writeWorkflow } from '../../skills/workflow-automation/build-workflow/scripts/build-workflow.mjs';
import { main as fetchMain } from '../../skills/workflow-automation/fetch-workflow/scripts/fetch-workflow.mjs';
import { redactDiff } from '../../skills/workflow-automation/publish-workflow/scripts/publish-workflow.mjs';
import { main as runMain } from '../../skills/workflow-automation/run-workflow/scripts/run-workflow.mjs';
import { main as validateMain } from '../../skills/workflow-automation/validate-workflow/scripts/validate-workflow.mjs';

const KEY = 'NRAK-SECRETKEY123';
const env = { NEW_RELIC_API_KEY: KEY, NEW_RELIC_ACCOUNT_ID: '1234' };
const capture = () => ({ text: '', write(s) { this.text += s; } });
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const wa = (inner) => ({ data: { actor: { account: { workflowAutomation: inner } } } });
const BUDGET_MS = 200;

// The three 50 KB strings that took seconds against the unanchored patterns.
const ADVERSARIAL = {
  'a x 50k': 'a'.repeat(5e4),
  'eyJ x 17k': 'eyJ'.repeat(17000),
  'http:// + a. x 25k': `http://${'a.'.repeat(25000)}`,
};

function timed(fn) {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}
async function timedAsync(fn) {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}
const under = (ms, label) => assert.ok(ms < BUDGET_MS, `${label} took ${ms.toFixed(0)} ms (budget ${BUDGET_MS} ms)`);

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'hardening-'));
});

// --- text helpers -------------------------------------------------------------------------------

test('truncate: short and non-string values pass through, long ones get an ellipsis (and optionally a count)', () => {
  assert.equal(truncate('short'), 'short');
  assert.equal(truncate('x'.repeat(MAX_UNTRUSTED_CHARS)), 'x'.repeat(MAX_UNTRUSTED_CHARS));
  assert.equal(truncate('x'.repeat(MAX_UNTRUSTED_CHARS + 1)), `${'x'.repeat(MAX_UNTRUSTED_CHARS)}…`);
  assert.equal(truncate('abcdef', 3, { count: true }), 'abc… (+3 chars)');
  assert.equal(truncate(42), 42);
  assert.equal(truncate(undefined), undefined);
});

test('stripControlChars: removes C0 and C1 controls except newline and tab', () => {
  assert.equal(stripControlChars('a\u001b[31mred\u001b[0m\u0007b\r\n\tc\u009bd\u0000e\u007ff'), 'a[31mred[0mb\n\tcdef');
  assert.equal(stripControlChars('\u001b]0;title\u0007ok'), ']0;titleok');
});

// --- regex DoS ----------------------------------------------------------------------------------

test('findToken: adversarial 50 KB values finish quickly and match nothing', () => {
  for (const [label, value] of Object.entries(ADVERSARIAL)) {
    const { result, ms } = timed(() => findToken(value));
    under(ms, `findToken(${label})`);
    assert.equal(result.label, null);
    assert.equal(result.truncated, true);
  }
  // Every individual pattern is fast too (the patterns themselves were quadratic, not just the loop).
  for (const [label, value] of Object.entries(ADVERSARIAL)) {
    for (const [name, pattern] of TOKEN_PATTERNS) {
      under(timed(() => pattern.test(value)).ms, `${name} on ${label}`);
    }
  }
});

test('token detections still work, including after the anchoring change', () => {
  const nrak = `NRAK-${'A1'.repeat(13)}Z`;
  const samples = {
    'New Relic API key': nrak,
    'URL with embedded credentials': 'postgres://admin:hunter2@db.example.com/app',
    JWT: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'AWS access key id': 'AKIAABCDEFGHIJKLMNOP',
    'Bearer token': 'Authorization: Bearer abcdefgh12345678',
    'Slack webhook URL': 'https://hooks.slack.com/services/T000/B000/XXXXXXXX',
  };
  for (const [label, value] of Object.entries(samples)) {
    assert.equal(findToken(value).label, label, label);
    assert.equal(findToken(`prefix=${value} suffix`).label, label, `${label} embedded`);
  }
  // A scheme such as jdbc:postgresql://u:p@host still matches from the inner scheme.
  assert.equal(findToken('jdbc:postgresql://u:p@host/db').label, 'URL with embedded credentials');
  // No credentials, or a secret reference as the password: no match.
  assert.equal(findToken('https://example.com/path').label, null);
  assert.equal(findToken('https://user:${{ :secrets:PW }}@example.com').label, null);
});

test('a token inside the first MAX_SCAN_CHARS of a long value is still found', () => {
  const found = findToken(`${'x '.repeat(100)}${`NRAK-${'A'.repeat(27)}`} ${'y'.repeat(MAX_SCAN_CHARS * 2)}`);
  assert.equal(found.label, 'New Relic API key');
  assert.equal(found.truncated, true);
});

const yamlWith = (value) => `name: wf\ndescription: test\nsteps:\n  - name: s1\n    type: action\n    action: newrelic.ingest.sendLogs\n    version: 1\n    inputs:\n      logs:\n        - message: ${value}\n`;

test('validateLocal / scanSecrets: adversarial values are fast and flagged as truncated for scanning', () => {
  for (const [label, value] of Object.entries(ADVERSARIAL)) {
    const text = yamlWith(`"${value}"`);
    const local = timed(() => validateLocal(text));
    under(local.ms, `validateLocal(${label})`);
    const flagged = local.result.findings.filter((f) => f.ruleId === 'secret-scan-truncated');
    assert.equal(flagged.length, 1, label);
    assert.equal(flagged[0].severity, 'warning');
    assert.match(flagged[0].message, new RegExp(`${value.length} chars; only the first ${MAX_SCAN_CHARS}`));
    assert.ok(!flagged[0].message.includes(value.slice(0, 30)) || value.length < 30);

    const scan = timed(() => scanSecrets(text));
    under(scan.ms, `scanSecrets(${label})`);
    assert.deepEqual(scan.result.map((f) => f.ruleId), ['secret-scan-truncated']);
  }
});

test('a token in the scanned prefix of a long YAML value is still an error', () => {
  const text = yamlWith(`"NRAK-${'A'.repeat(27)} ${'z'.repeat(20000)}"`);
  const rules = validateLocal(text).findings.map((f) => f.ruleId);
  assert.ok(rules.includes('plaintext-token'));
  assert.ok(rules.includes('secret-scan-truncated'));
});

test('validate-workflow entry point: adversarial value finishes quickly', async () => {
  mkdirSync(join(cwd, 'workflows'));
  for (const [label, value] of Object.entries(ADVERSARIAL)) {
    writeFileSync(join(cwd, 'workflows', 'wf.yaml'), yamlWith(`"${value}"`));
    const stdout = capture();
    const { ms } = await timedAsync(() => validateMain(['workflows/wf.yaml', '--local-only'], { env, stdout, stderr: capture(), cwd }));
    under(ms, `validate main(${label})`);
    assert.match(stdout.text, /secret-scan-truncated/);
  }
});

test('checkRunInputs: adversarial 50 KB values are fast; a clean long value is flagged, a leading token is an error', () => {
  const inputs = { v: { type: 'String' } };
  for (const [label, value] of Object.entries(ADVERSARIAL)) {
    const { result, ms } = timed(() => checkRunInputs(inputs, { v: value }));
    under(ms, `checkRunInputs(${label})`);
    assert.deepEqual(result.findings.map((f) => [f.ruleId, f.severity]), [['input-scan-truncated', 'warning']]);
    assert.equal(result.resolved[0].value, value, 'the supplied value itself is sent unchanged');
  }
  const bad = checkRunInputs(inputs, { v: `NRAK-${'A'.repeat(27)}${' '.repeat(1e5)}` });
  assert.deepEqual(bad.findings.map((f) => f.ruleId), ['input-plaintext-token']);
  assert.equal(bad.resolved[0].value, '[REDACTED]');
});

test('checkRunInputs: numeric validation of a long digit string with a bad tail is fast', () => {
  const { ms } = timed(() => checkRunInputs({ f: { type: 'Float' }, i: { type: 'Int' } }, { f: `${'1'.repeat(5e4)}x`, i: `${'1'.repeat(5e4)}x` }));
  under(ms, 'Float/Int coercion');
});

test('redactDiff: adversarial long lines are fast and redacted whole', () => {
  for (const [label, value] of Object.entries(ADVERSARIAL)) {
    const { result, ms } = timed(() => redactDiff(`--- a\n+++ b\n@@ -1,1 +1,1 @@\n+      note: ${value}\n`, KEY));
    under(ms, `redactDiff(${label})`);
    assert.equal(result.redacted, true);
    assert.ok(!result.diff.includes(value.slice(0, 50)));
  }
});

test('redactDiff: lines just under the scan cap are fast too (inline-key scan is not quadratic)', () => {
  for (const value of ['a'.repeat(MAX_SCAN_CHARS - 20), 'a:'.repeat(MAX_SCAN_CHARS / 2 - 10), 'a-'.repeat(MAX_SCAN_CHARS / 2 - 10)]) {
    const { ms } = timed(() => redactDiff(`--- a\n+++ b\n@@ -1,1 +1,1 @@\n+  note: ${value}\n`, KEY));
    under(ms, 'redactDiff near the cap');
  }
  const { diff } = redactDiff('--- a\n+++ b\n@@ -1,1 +1,1 @@\n+  headers: {"X-Api-Key": "abc123", ok: 1}\n', KEY);
  assert.ok(!diff.includes('abc123'));
});

test('redactDiff: a secret in the tail of a too-long line is not leaked; normal lines still redact', () => {
  const tail = `NRAK-${'B'.repeat(27)}`;
  const long = `+      body: ${'x'.repeat(MAX_SCAN_CHARS)}${tail}`;
  const { diff, redacted } = redactDiff(`--- a\n+++ b\n@@ -1,1 +1,1 @@\n${long}\n+      other: ${tail}\n`, KEY);
  assert.ok(!diff.includes('BBBB'));
  assert.ok(!diff.includes('xxxx'));
  assert.match(diff, /^\+\[REDACTED: \d+-char line not shown\]$/m);
  assert.match(diff, /^\+ {6}other: NRAK…\[REDACTED\]$/m);
  assert.equal(redacted, true);
});

test('fetch-workflow entry point: adversarial value is fast and reported as unscanned, not as a secret', async () => {
  for (const [label, value] of Object.entries(ADVERSARIAL)) {
    const yaml = yamlWith(`"${value}"`);
    const fetchImpl = async (url, init) => {
      const { query } = JSON.parse(init.body);
      const body = query.includes('ListWorkflows')
        ? wa({ workflows: { nextCursor: null, results: [{ definition: { name: 'wf', version: 1 } }] } })
        : wa({ workflow: { definition: { name: 'wf', version: 1, yaml: b64(yaml) } } });
      return new Response(JSON.stringify({ data: body.data }), { status: 200 });
    };
    const stdout = capture();
    const dir = mkdtempSync(join(tmpdir(), 'fetch-adv-'));
    const { result: code, ms } = await timedAsync(() => fetchMain(['get', '--name', 'wf'], { env, stdout, stderr: capture(), cwd: dir, fetchImpl }));
    under(ms, `fetch main(${label})`);
    assert.equal(code, 0);
    const json = JSON.parse(stdout.text);
    assert.equal(json.plaintextSecrets, undefined, label);
    assert.equal(json.secretScanTruncated.count, 1);
    assert.deepEqual(json.secretScanTruncated.paths.length, 1);
  }
});

// --- untrusted text limits ----------------------------------------------------------------------

const LONG = (c, n = 500) => c.repeat(n);

test('checkRunInputs: errorMessage, enumValues, declared names and regex text are bounded', () => {
  const inputs = {
    [LONG('n', 300)]: { type: 'String', validations: [{ type: 'maxLength', errorMessage: LONG('e'), length: 1 }, { type: 'regex', errorMessage: 'bad', pattern: `^(${LONG('q')}` }] },
    lvl: { type: 'Enum', enumValues: [LONG('z'), 'ok'], required: false },
    [LONG('m', 400)]: { type: LONG('T', 400) },
  };
  const { findings } = checkRunInputs(inputs, { [LONG('n', 300)]: 'toolong', lvl: 'bad', extra: 'x' });
  assert.ok(findings.length >= 4);
  const cap = MAX_UNTRUSTED_CHARS;
  for (const f of findings) {
    assert.ok(f.message.length < 3 * cap + 200, `${f.ruleId} message is ${f.message.length} chars`);
    assert.ok(f.path.length <= cap + 1);
  }
  const text = JSON.stringify(findings);
  assert.ok(!text.includes(LONG('e', 201)));
  assert.ok(!text.includes(LONG('z', 201)));
  assert.ok(!text.includes(LONG('n', 201)));
  assert.ok(!text.includes(LONG('m', 201)));
  assert.ok(!text.includes(LONG('T', 201)));
  assert.ok(!text.includes(LONG('q', 201)));
  assert.ok(text.includes(`${LONG('e', cap)}…`));
  assert.ok(text.includes(`${LONG('z', cap)}…`));
});

function runRouter({ yaml, calls }) {
  return async (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    calls.push({ query, variables });
    let body;
    if (query.includes('ListWorkflows')) body = wa({ workflows: { nextCursor: null, results: [{ definition: { name: 'demo', version: 1 } }] } });
    else if (query.includes('GetWorkflow')) body = wa({ workflow: { definition: { name: 'demo', version: 1, yaml: b64(yaml) } } });
    else if (query.includes('mutation StartWorkflowRun')) body = { data: { workflowAutomationStartWorkflowRun: { runId: 'run-1' } } };
    else body = wa({ workflowRunInfo: { status: 'COMPLETED', logUrl: 'https://one.newrelic.com/x', state: [] } });
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

test('run plan bounds published descriptions, input names and default values; start still sends the full names', async () => {
  const longName = LONG('a', 300);
  const yaml = `name: demo
description: ${LONG('d')}
workflowInputs:
  ${longName}:
    type: String
    validations:
      - type: maxLength
        errorMessage: ${LONG('E')}
        length: 1
  lvl:
    type: Enum
    enumValues: [${LONG('Z')}, ok]
    required: false
  dflt:
    type: String
    defaultValue: ${LONG('D')}
steps:
  - name: s1
    type: action
    action: newrelic.ingest.sendLogs
    version: 1
`;
  const calls = [];
  const run = async (argv) => {
    const stdout = capture();
    const code = await runMain(argv, { env, stdout, stderr: capture(), cwd, fetchImpl: runRouter({ yaml, calls }), sleep: async () => {} });
    return { code, text: stdout.text, json: JSON.parse(stdout.text) };
  };

  const bad = await run(['plan', 'demo', '--inputs-json', JSON.stringify({ [longName]: 'toolong', lvl: 'nope' })]);
  assert.equal(bad.code, 3);
  const cap = MAX_UNTRUSTED_CHARS;
  for (const c of ['d', 'a', 'E', 'Z', 'D']) assert.ok(!bad.text.includes(LONG(c, cap + 1)), `${c} not bounded in plan output`);
  assert.equal(bad.json.description, `${LONG('d', cap)}…`);
  assert.deepEqual(bad.json.declaredInputs, [`${LONG('a', cap)}…`, 'lvl', 'dflt']);
  assert.ok(bad.json.findings.every((f) => f.message.length < 3 * cap));

  const good = await run(['plan', 'demo', '--inputs-json', JSON.stringify({ [longName]: 'x' })]);
  assert.equal(good.code, 0);
  const shown = good.json.inputs;
  assert.equal(shown[0].key, `${LONG('a', cap)}…`);
  assert.equal(shown.find((i) => i.key === 'dflt').value, `${LONG('D', cap)}…`);
  assert.match(good.json.expect, /^demo@1#[0-9a-f]{12}$/);

  const started = await run(['start', 'demo', '--inputs-json', JSON.stringify({ [longName]: 'x' }), '--expect', good.json.expect]);
  assert.equal(started.code, 0);
  assert.equal(started.json.started, true);
  const mutation = calls.find((c) => c.query.includes('mutation StartWorkflowRun'));
  assert.deepEqual(mutation.variables.workflowInputs, [{ key: longName, value: 'x' }]);
});

test('run env includes tmpDir', async () => {
  const stdout = capture();
  assert.equal(await runMain(['env'], { env, stdout, stderr: capture(), cwd }), 0);
  assert.equal(JSON.parse(stdout.text).tmpDir, tmpdir());
});

const liveCatalog = (description) => async (url, init) => {
  if (String(url).includes('docs.newrelic.com')) return new Response('nope', { status: 404 });
  const body = wa({ actionDefinitions: { results: [{ name: 'demo.thing.run', version: 1, description, inputs: [{
    name: 'in1', type: 'STRING', required: true, secretAllowed: false, example: null,
    validations: [{ __typename: 'WorkflowAutomationRegexValidation', errorMessage: LONG('R'), regexConstraint: '.*' }],
  }], outputs: [], timeout: { action: 30 } }] } });
  return new Response(JSON.stringify(body), { status: 200 });
};
const live = () => ({ config: getConfig(env), accountId: 1234 });

test('live action descriptions and validation messages are capped (300 / 200 chars)', async () => {
  const description = LONG('x', 1000);
  const opts = { fetchImpl: liveCatalog(description) };
  const listed = await listActions({ verbose: true, live: live() }, opts);
  assert.equal(listed[0].description, `${LONG('x', 300)}…`);
  const described = await describeAction({ action: 'demo.thing.run', live: live() }, opts);
  assert.equal(described.description, `${LONG('x', 300)}…`);
  assert.equal(described.inputs[0].validations[0].errorMessage, `${LONG('R', 200)}…`);
});

test('hardcoded-environment-value echoes at most 200 characters of an ARN', () => {
  const arn = `arn:aws:sqs:us-east-1:123456789012:${LONG('q', 1000)}`;
  const finding = validateLocal(yamlWith('hi').replace('logs:\n        - message: hi', `queue: "${arn}"`)).findings.find((f) => f.ruleId === 'hardcoded-environment-value');
  assert.ok(finding, 'finding present');
  assert.ok(finding.message.includes(`${arn.slice(0, 200)}…`));
  assert.ok(!finding.message.includes(arn.slice(0, 201)));
});

// --- write safety -------------------------------------------------------------------------------

const draft = 'name: wf\nsteps:\n  - name: s1\n    type: action\n    action: a.b\n    version: 1\n';
const isSymlinkRefusal = (err) => err instanceof UsageError && /symbolic link/.test(err.message);

test('writeNoOverwrite: a symlinked workflows/ directory is refused (nothing is created through it)', () => {
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  symlinkSync(outside, join(cwd, 'workflows'));
  for (const force of [false, true]) {
    assert.throws(() => writeNoOverwrite(join(cwd, 'workflows', 'wf.yaml'), 'x', force, cwd), isSymlinkRefusal);
    assert.throws(() => writeNoOverwrite(join(cwd, 'workflows', 'wf.yaml'), 'x', force), isSymlinkRefusal, 'parent is checked even without a root');
  }
  assert.equal(existsSync(join(outside, 'wf.yaml')), false);
});

test('writeNoOverwrite: a symlinked target is refused, including with force; the link target is untouched', () => {
  const outside = join(mkdtempSync(join(tmpdir(), 'outside-')), 'victim.txt');
  writeFileSync(outside, 'original');
  mkdirSync(join(cwd, 'workflows'));
  symlinkSync(outside, join(cwd, 'workflows', 'wf.yaml'));
  for (const force of [false, true]) {
    assert.throws(() => writeNoOverwrite(join(cwd, 'workflows', 'wf.yaml'), 'pwned', force, cwd), isSymlinkRefusal);
  }
  assert.equal(readFileSync(outside, 'utf8'), 'original');
  // A dangling link is refused as well, so it cannot be used to create a file elsewhere.
  symlinkSync(join(cwd, 'nowhere', 'new.txt'), join(cwd, 'workflows', 'dangling.yaml'));
  assert.throws(() => writeNoOverwrite(join(cwd, 'workflows', 'dangling.yaml'), 'x', true, cwd), isSymlinkRefusal);
  assert.equal(existsSync(join(cwd, 'nowhere')), false);
});

test('writeNoOverwrite: a symlink anywhere between the project root and the file is refused when a root is given', () => {
  mkdirSync(join(cwd, 'real'));
  symlinkSync(join(cwd, 'real'), join(cwd, 'link'));
  assert.throws(() => writeNoOverwrite(join(cwd, 'link', 'sub', 'wf.yaml'), 'x', false, cwd), isSymlinkRefusal);
  assert.throws(() => assertNoSymlinks(join(cwd, 'link', 'sub', 'wf.yaml'), cwd), isSymlinkRefusal);
});

test('writeNoOverwrite: normal writes, wx semantics and --force overwrite are unchanged', () => {
  const path = join(cwd, 'workflows', 'sub', 'wf.yaml');
  writeNoOverwrite(path, 'one', false, cwd);
  assert.equal(readFileSync(path, 'utf8'), 'one');
  assert.throws(() => writeNoOverwrite(path, 'two', false, cwd), (err) => err instanceof UsageError && /already exists\. Pass --force/.test(err.message));
  writeNoOverwrite(path, 'three', true, cwd);
  assert.equal(readFileSync(path, 'utf8'), 'three');
  writeNoOverwrite(path, 'shorter', true, cwd);
  assert.equal(readFileSync(path, 'utf8'), 'shorter', 'force truncates');
});

test('assertInsideCwd: ../ escapes, absolute outside paths, and symlinks pointing out are refused; inside paths pass', () => {
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  const inside = (p) => assertInsideCwd(join(cwd, p), cwd, '--out');
  const refused = (err) => err instanceof UsageError && /--out must be inside the project directory/.test(err.message);
  assert.throws(() => assertInsideCwd(join(cwd, '..', 'x.yaml'), cwd), refused);
  assert.throws(() => assertInsideCwd(join(outside, 'x.yaml'), cwd), refused);
  assert.throws(() => assertInsideCwd(join(cwd, 'a', '..', '..', 'x.yaml'), cwd), refused);
  symlinkSync(outside, join(cwd, 'escape'));
  assert.throws(() => inside('escape/x.yaml'), refused);
  assert.throws(() => inside('escape/deeper/x.yaml'), refused);
  assert.doesNotThrow(() => inside('x.yaml'));
  assert.doesNotThrow(() => inside('workflows/x.yaml'));
  assert.doesNotThrow(() => inside('new/dirs/x.yaml'));
  mkdirSync(join(cwd, 'workflows'));
  assert.doesNotThrow(() => inside('workflows/x.yaml'));
});

test('assertInsideCwd: works when cwd itself is reached through a symlink (macOS /var -> /private/var)', () => {
  const real = realpathSync(cwd);
  const viaLink = join(mkdtempSync(join(tmpdir(), 'linkroot-')), 'proj');
  symlinkSync(real, viaLink);
  assert.doesNotThrow(() => assertInsideCwd(join(viaLink, 'workflows', 'x.yaml'), viaLink));
  assert.throws(() => assertInsideCwd(join(viaLink, '..', 'x.yaml'), viaLink), UsageError);
});

test('build-workflow write: --out outside the project is refused (exit-1 UsageError), inside works, symlinked workflows/ refused', () => {
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  // The skill script uses its own lib/ copy of UsageError, so match by name rather than class.
  const refused = (err) => err.constructor.name === 'UsageError' && /--out must be inside the project directory/.test(err.message);
  const symlinkRefusal = (err) => err.constructor.name === 'UsageError' && /symbolic link/.test(err.message);
  assert.throws(() => writeWorkflow({ text: draft, out: '../escape.yaml', force: false, cwd }), refused);
  assert.throws(() => writeWorkflow({ text: draft, out: join(outside, 'x.yaml'), force: true, cwd }), refused);
  assert.equal(existsSync(join(outside, 'x.yaml')), false);

  const ok = writeWorkflow({ text: draft, out: 'custom/wf.yaml', force: false, cwd });
  assert.equal(ok.path, join(cwd, 'custom', 'wf.yaml'));
  assert.equal(writeWorkflow({ text: draft, force: false, cwd }).path, join(cwd, 'workflows', 'wf.yaml'));

  const other = mkdtempSync(join(tmpdir(), 'proj-'));
  symlinkSync(outside, join(other, 'workflows'));
  assert.throws(() => writeWorkflow({ text: draft, force: true, cwd: other }), symlinkRefusal);
  assert.throws(() => writeWorkflow({ text: draft, out: 'workflows/wf.yaml', force: true, cwd: other }), refused);
  assert.equal(existsSync(join(outside, 'wf.yaml')), false);
});

test('fetch-workflow get: --out ../x.yaml and absolute outside paths exit 1; symlinked workflows/ and target refused', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  const yaml = draft;
  const fetchImpl = async (url, init) => {
    const { query } = JSON.parse(init.body);
    const body = query.includes('ListWorkflows')
      ? wa({ workflows: { nextCursor: null, results: [{ definition: { name: 'wf', version: 1 } }] } })
      : wa({ workflow: { definition: { name: 'wf', version: 1, yaml: b64(yaml) } } });
    return new Response(JSON.stringify({ data: body.data }), { status: 200 });
  };
  const get = async (extra, dir = cwd) => {
    const stderr = capture();
    const stdout = capture();
    const code = await fetchMain(['get', '--name', 'wf', ...extra], { env, stdout, stderr, cwd: dir, fetchImpl });
    return { code, stdout: stdout.text, stderr: stderr.text };
  };

  for (const out of ['../x.yaml', join(outside, 'x.yaml')]) {
    const r = await get(['--out', out, '--force']);
    assert.equal(r.code, 1, out);
    assert.match(r.stderr, /--out must be inside the project directory/);
    assert.equal(r.stdout, '');
  }
  assert.equal(existsSync(join(outside, 'x.yaml')), false);

  const okRun = await get(['--out', 'workflows/copy.yaml']);
  assert.equal(okRun.code, 0);
  assert.equal(readFileSync(join(cwd, 'workflows', 'copy.yaml'), 'utf8'), yaml);
  assert.equal((await get([])).code, 0, 'default path works');
  assert.equal((await get([])).code, 1, 'second write without --force still refuses to overwrite');

  const proj = mkdtempSync(join(tmpdir(), 'proj-'));
  symlinkSync(outside, join(proj, 'workflows'));
  const viaDir = await get(['--force'], proj);
  assert.equal(viaDir.code, 1);
  assert.match(viaDir.stderr, /symbolic link/);
  assert.equal(existsSync(join(outside, 'wf.yaml')), false);

  const proj2 = mkdtempSync(join(tmpdir(), 'proj-'));
  mkdirSync(join(proj2, 'workflows'));
  const victim = join(outside, 'victim.yaml');
  writeFileSync(victim, 'original');
  symlinkSync(victim, join(proj2, 'workflows', 'wf.yaml'));
  const viaFile = await get(['--force'], proj2);
  assert.equal(viaFile.code, 1);
  assert.match(viaFile.stderr, /symbolic link/);
  assert.equal(readFileSync(victim, 'utf8'), 'original');
});

// --- stderr sanitizing --------------------------------------------------------------------------

test('reportError strips control characters but keeps newlines and tabs', () => {
  const stderr = capture();
  const code = reportError(new UsageError('bad\u001b[2J\u001b]0;pwned\u0007 input\u009b31m\r\n\tline2\u0000'), stderr);
  assert.equal(code, 1);
  assert.equal(stderr.text, 'Error: bad[2J]0;pwned input31m\n\tline2\n');
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(stderr.text));
});

test('entry points sanitize error text from the server before writing it to stderr', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ errors: [{ message: 'denied \u001b[31mRED\u001b]0;title\u0007' }] }), { status: 200 });
  const stderr = capture();
  const code = await fetchMain(['list'], { env, stdout: capture(), stderr, cwd, fetchImpl });
  assert.equal(code, 2);
  assert.ok(stderr.text.includes('denied'));
  assert.ok(!stderr.text.includes('\u001b'));
  assert.ok(!stderr.text.includes('\u0007'));
});
