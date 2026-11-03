import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { scanSecrets } from '../../shared/workflow-automation/validation.mjs';
import { parseYaml } from '../../shared/workflow-automation/yaml.mjs';
import { checkSecretRef, main, validateLocal } from '../../skills/workflow-automation/validate-workflow/scripts/validate-workflow.mjs';

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

// Every complete workflow example in references/definition-schema.md must pass local checks.
const SCHEMA_DOC = readFileSync(new URL('../../shared/workflow-automation/references/definition-schema.md', import.meta.url), 'utf8');
const DOC_EXAMPLES = [...SCHEMA_DOC.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]).filter((y) => /^name: /m.test(y) && /^steps:/m.test(y));

const errorsOf = (text) => validateLocal(text).findings.filter((f) => f.severity === 'error');
const rules = (text, severity = 'error') => validateLocal(text).findings.filter((f) => f.severity === severity).map((f) => f.ruleId);
const action = (extra = '', inputs = '      logs:\n        - message: hi\n') =>
  `name: wf\ndescription: test\nsteps:\n  - name: s1\n    type: action\n    action: newrelic.ingest.sendLogs\n    version: 1\n${extra}    inputs:\n${inputs}`;

const validationResponse = (valid, errors = []) => ({
  data: { actor: { account: { workflowAutomation: { workflowDefinitionValidation: { valid, errors: errors.map((message) => ({ message })) } } } } },
});

function fakeFetch(calls, respond = () => ({ body: validationResponse(true) })) {
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
  cwd = mkdtempSync(join(tmpdir(), 'validate-wf-'));
  calls = [];
});

const writeWorkflow = (file, text) => {
  mkdirSync(join(cwd, 'workflows'), { recursive: true });
  writeFileSync(join(cwd, 'workflows', file), text);
};

const run = async (argv, { respond, ...extra } = {}) => {
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, { env, stdout, stderr, cwd, fetchImpl: fakeFetch(calls, respond), ...extra });
  return { code, stdout: stdout.text, stderr: stderr.text, json: stdout.text.startsWith('{') ? JSON.parse(stdout.text) : null };
};

test('schema doc examples pass local checks', () => {
  assert.ok(DOC_EXAMPLES.length >= 10);
  for (const yaml of DOC_EXAMPLES) assert.deepEqual(errorsOf(yaml), [], yaml.split('\n')[0]);
});

test('valid workflow has no findings', () => {
  assert.deepEqual(validateLocal(VALID).findings, []);
});

test('YAML parse errors carry line and column and stop further checks', () => {
  const { doc, findings } = validateLocal('name: wf\nsteps:\n  - name: a\n   type: wait\n');
  assert.equal(doc, null);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'yaml');
  assert.equal(typeof findings[0].line, 'number');
  assert.equal(typeof findings[0].column, 'number');
});

test('duplicate keys, multiple documents, and non-map roots are YAML errors', () => {
  assert.deepEqual(rules('name: a\nname: b\nsteps: []\n'), ['yaml-parse']);
  assert.deepEqual(rules(`${VALID}---\n${VALID}`), ['yaml-documents']);
  assert.deepEqual(rules('- a\n- b\n'), ['yaml-root']);
});

test('unknown keys are errors with a did-you-mean hint', () => {
  const findings = errorsOf(action('    ignoreError: true\n'));
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, 'unknown-key');
  assert.equal(findings[0].path, 'steps[0].ignoreError');
  assert.match(findings[0].message, /did you mean "ignoreErrors"/);
  assert.deepEqual(rules(`foo: 1\n${VALID}`), ['unknown-key']);
});

test('workflow name and description formats', () => {
  assert.deepEqual(rules(VALID.replace('demoWorkflow', '1bad')), ['name-format']);
  assert.deepEqual(rules(VALID.replace('demoWorkflow', 'ok-name_1')), []);
  assert.deepEqual(rules(VALID.replace('Logs a message', '"Logs a message!"')), ['description-format']);
  assert.deepEqual(rules(VALID.replace('Logs a message', 'x'.repeat(201))), ['description-length']);
  assert.deepEqual(rules(VALID.replace('name: demoWorkflow\n', '')), ['required']);
});

test('step names must be expression-safe and not reserved', () => {
  assert.deepEqual(rules(action().replace('name: s1', 'name: s-1')), ['step-name-format']);
  assert.deepEqual(rules(action().replace('name: s1', 'name: end')), ['step-name-reserved']);
});

test('action version may be int or string but is required', () => {
  assert.deepEqual(rules(action()), []);
  assert.deepEqual(rules(action().replace('version: 1', "version: '1'")), []);
  const missing = errorsOf(action().replace('    version: 1\n', ''));
  assert.deepEqual(missing.map((f) => [f.ruleId, f.path]), [['required', 'steps[0].version']]);
  assert.deepEqual(rules(action().replace('newrelic.ingest.sendLogs', 'sendLogs')), ['action-format']);
});

test('workflowInputs types, enums and validations', () => {
  const wf = (inputs) => `name: wf\ndescription: test\nworkflowInputs:\n${inputs}steps:\n  - name: w\n    type: wait\n    seconds: 1\n`;
  assert.deepEqual(rules(wf('  a:\n    type: Number\n')), ['input-type']);
  assert.match(errorsOf(wf('  a:\n    type: Number\n'))[0].message, /use Int or Float/);
  assert.deepEqual(rules(wf('  a:\n    type: Enum\n')), ['enum-values']);
  assert.deepEqual(rules(wf('  a:\n    type: Enum\n    enumValues: [x, y]\n')), []);
  assert.deepEqual(rules(wf('  bad-name:\n    type: String\n')), ['input-name-format']);
  assert.deepEqual(rules(wf('  a:\n    type: Int\n    validations:\n      - type: minIntValue\n        errorMessage: too small\n')), ['required']);
  assert.deepEqual(rules(wf('  a:\n    type: Int\n    validations:\n      - type: between\n        errorMessage: x\n')), ['validation-type']);
});

test('per-type required fields', () => {
  const step = (body) => `name: wf\ndescription: test\nsteps:\n  - name: s\n${body}`;
  assert.deepEqual(rules(step('    type: loop\n')), ['required']);
  assert.deepEqual(rules(step('    type: switch\n')), ['required']);
  assert.deepEqual(rules(step('    type: wait\n')), ['required']);
  assert.deepEqual(rules(step('    type: wait\n    seconds: -1\n')), ['wait-seconds']);
  assert.deepEqual(rules(step('    type: assign\n')), ['required']);
  assert.deepEqual(rules(step('    type: state\n    inputs:\n      bad-key: 1\n')), ['state-key-format']);
  assert.deepEqual(rules(step('    type: switch\n    switch:\n      - condition: x\n')), ['required']);
  assert.deepEqual(rules(step('    type: teleport\n')), ['step-type']);
});

test('nested loop steps are checked', () => {
  const yaml = 'name: wf\ndescription: test\nsteps:\n  - name: l\n    type: loop\n    for:\n      in: ${{ [1] }}\n      steps:\n        - name: inner-step\n          type: wait\n          seconds: 1\n';
  assert.deepEqual(errorsOf(yaml).map((f) => f.path), ['steps[0].for.steps[0].name']);
});

test('flow rules are left to the server', () => {
  const yaml = 'name: wf\ndescription: test\nsteps:\n  - name: a\n    type: wait\n    seconds: 1\n    next: nowhere\n  - name: a\n    type: wait\n    seconds: 1\n';
  assert.deepEqual(errorsOf(yaml), []);
});

test('limits', () => {
  const wait = (seconds) => `name: wf\ndescription: test\nsteps:\n  - name: w\n    type: wait\n    seconds: ${seconds}\n`;
  assert.deepEqual(rules(wait(86401)), ['wait-seconds']);
  assert.deepEqual(rules(wait(86400)), []);

  const many = (n) => `name: wf\ndescription: test\nsteps:\n${Array.from({ length: n }, (_, i) => `  - name: w${i}\n    type: wait\n    seconds: 1\n`).join('')}`;
  assert.deepEqual(rules(many(100)), []);
  assert.deepEqual(rules(many(101)), ['total-steps']);

  const cases = Array.from({ length: 11 }, () => '      - condition: x\n        next: end\n').join('');
  assert.deepEqual(rules(`name: wf\ndescription: test\nsteps:\n  - name: s\n    type: switch\n    switch:\n${cases}`), ['switch-conditions']);

  const signals = Array.from({ length: 11 }, (_, i) => `      - name: s${i}\n        next: end\n`).join('');
  assert.deepEqual(rules(`name: wf\ndescription: test\nsteps:\n  - name: w\n    type: wait\n    seconds: 1\n    signals:\n${signals}`), ['wait-signals']);

  const keys = Array.from({ length: 11 }, (_, i) => `      k${i}: 1\n`).join('');
  assert.deepEqual(rules(`name: wf\ndescription: test\nsteps:\n  - name: s\n    type: state\n    inputs:\n${keys}`), ['state-keys-per-step']);
  assert.deepEqual(rules(`name: wf\ndescription: test\nsteps:\n  - name: s\n    type: state\n    inputs:\n      k: "${'x'.repeat(1001)}"\n`), ['state-value-length']);

  const states = Array.from({ length: 11 }, (_, s) => `  - name: s${s}\n    type: state\n    inputs:\n${Array.from({ length: 10 }, (_, k) => `      k${k}: 1\n`).join('')}`).join('');
  assert.deepEqual(rules(`name: wf\ndescription: test\nsteps:\n${states}`, 'warning'), ['state-keys-total']);

  const big = action('', `      logs:\n        - message: "${'x'.repeat(52000)}"\n`);
  assert.deepEqual(rules(big), ['definition-size']);
});

test('plaintext secrets are errors and values are redacted', () => {
  const findings = errorsOf(action('', '      headers:\n        Authorization: supersecretvalue\n'));
  assert.deepEqual(findings.map((f) => [f.ruleId, f.path]), [['plaintext-secret', 'steps[0].inputs.headers.Authorization']]);
  assert.ok(!findings[0].message.includes('supersecretvalue'));
  assert.match(findings[0].message, /«16 chars»/);

  // Built at runtime so the source never holds a real-format key that secret scanners would flag.
  const nrak = `NRAK-${'A'.repeat(27)}`;
  const token = errorsOf(action('', `      body: "key ${nrak}"\n`));
  assert.equal(token[0].ruleId, 'plaintext-token');
  assert.ok(!token[0].message.includes(nrak));

  assert.deepEqual(rules(action('', '      headers:\n        Authorization: Bearer abcdefgh12345678\n')), ['plaintext-token']);
  assert.deepEqual(rules(action('', '      headers:\n        Authorization: Bearer ${{ :secrets:apiToken }}\n')), []);
  assert.deepEqual(rules(action('', '      password: ${{ :secrets:ACCOUNT:aws:dbPassword }}\n')), []);
});

test('plaintext secrets: numeric values under sensitive keys are errors, with guards against false positives', () => {
  const nums = errorsOf(action('', '      password: 12345678\n'));
  assert.deepEqual(nums.map((f) => [f.ruleId, f.path]), [['plaintext-secret', 'steps[0].inputs.password']]);
  assert.ok(!nums[0].message.includes('12345678'));
  assert.deepEqual(rules(action('', '      apiKey: 123456\n')), ['plaintext-secret']);
  assert.deepEqual(rules(action('', '      maxTokens: 100000\n')), []);
  assert.deepEqual(rules(action('', '      passwordLength: 12\n')), []);
  assert.deepEqual(rules(action('', '      secretRotation: true\n')), []);
});

test('plaintext secrets: JSON-string values are checked as structured data, once', () => {
  const found = errorsOf(action('', `      headers: '{"X-Api-Key": "abc123def456", "Accept": "json"}'\n`));
  assert.deepEqual(found.map((f) => [f.ruleId, f.path]), [['plaintext-secret', 'steps[0].inputs.headers["X-Api-Key"]']]);
  assert.ok(!found[0].message.includes('abc123def456'));
  assert.deepEqual(rules(action('', `      headers: '{"X-Api-Key": "\${{ :secrets:API_KEY }}"}'\n`)), []);
  assert.deepEqual(rules(action('', `      headers: '{"Accept": "json"}'\n`)), []);
  assert.deepEqual(rules(action('', `      headers: '{"Authorization": "Bearer abcdefgh12345678"}'\n`)), ['plaintext-token']);
  assert.deepEqual(rules(action('', `      headers: '{"Authorization": "\${{ :secrets:bad name }}"}'\n`)), ['secret-ref-format']);
  assert.deepEqual(rules(action('', `      body: '{not json, password: abc'\n`)), []);
});

test('widened sensitive keys: hyphenated api keys, pwd, passwd, credentials', () => {
  for (const key of ['X-Api-Key', 'api-key', 'pwd', 'passwd', 'dbCredentials', 'license-key']) {
    assert.deepEqual(rules(action('', `      headers:\n        ${key}: abcd1234efgh5678\n`)), ['plaintext-secret'], key);
  }
});

test('token patterns: webhook hosts, NR insert and license keys, credentials in URLs', () => {
  // Built at runtime so no realistic-looking secret sits in the source.
  const values = {
    'Slack webhook URL': `https://hooks.slack.com/services/${'T0'.repeat(4)}/${'B0'.repeat(4)}/${'x'.repeat(24)}`,
    'Microsoft Teams webhook URL': `https://acme.webhook.office.com/webhookb2/${'a'.repeat(8)}@${'b'.repeat(8)}/IncomingWebhook/${'c'.repeat(16)}`,
    'Azure Logic Apps webhook URL': `https://prod-01.westus.logic.azure.com:443/workflows/${'d'.repeat(16)}/triggers/manual/paths/invoke?sig=${'e'.repeat(16)}`,
    'New Relic insert key': `NRII-${'f'.repeat(32)}`,
    'New Relic license key': `${'0a'.repeat(18)}NRAL`,
    'URL with embedded credentials': 'https://bob:hunter2pass@example.com/api',
  };
  for (const [label, value] of Object.entries(values)) {
    const findings = errorsOf(action('', `      body: "${value}"\n`));
    assert.deepEqual(findings.map((f) => f.ruleId), ['plaintext-token'], label);
    assert.ok(findings[0].message.includes(label), label);
    assert.ok(!findings[0].message.includes(value), label);
    assert.match(findings[0].message, /«\d+ chars»/);
  }
  assert.deepEqual(rules(action('', '      url: "https://bob:${{ :secrets:pw }}@example.com/api"\n')), []);
  assert.deepEqual(rules(action('', '      url: "https://example.com/a@b"\n')), []);
});

test('token patterns: lowercase NRAK bodies, non-hex EU/JP license keys, and the other New Relic key prefixes', () => {
  const values = [
    ['New Relic API key', `NRAK-${'a1'.repeat(13)}b`],
    ['New Relic license key', `eu01xx${'a'.repeat(30)}NRAL`],
    ['New Relic NRIQ key', `NRIQ-${'a'.repeat(24)}`],
    ['New Relic NRJS key', `NRJS-${'0f'.repeat(10)}`],
    ['New Relic NRBR key', `NRBR-${'a'.repeat(24)}`],
    ['New Relic NRSP key', `NRSP-${'a'.repeat(24)}`],
    ['New Relic NRRA key', `NRRA-${'a'.repeat(24)}`],
  ];
  for (const [label, value] of values) {
    const findings = errorsOf(action('', `      body: "${value}"\n`));
    assert.deepEqual(findings.map((f) => f.ruleId), ['plaintext-token'], label);
    assert.ok(findings[0].message.includes(label), label);
    assert.ok(!findings[0].message.includes(value), label);
  }
  // A bare prefix or a short body is not a key.
  assert.deepEqual(rules(action('', '      body: "NRIQ-short"\n')), []);
});

test('scanSecrets: plaintext findings only, null when the text is not one YAML mapping', () => {
  const token = `NRAK-${'A'.repeat(27)}`;
  const found = scanSecrets(action('', `      apiKey: ${token}\n      note: hello\n`));
  assert.deepEqual(found.map((f) => [f.ruleId, f.path]), [['plaintext-token', 'steps[0].inputs.apiKey']]);
  assert.ok(!JSON.stringify(found).includes(token));
  assert.deepEqual(scanSecrets(action('', '      apiKey: ${{ :secrets:KEY }}\n')), []);
  // A malformed secret reference is a validate finding, not a plaintext one.
  assert.deepEqual(scanSecrets(action('', '      apiKey: "${{ :secrets: }}"\n')), []);
  assert.equal(scanSecrets('a: [unclosed'), null);
  assert.equal(scanSecrets('- just\n- a list\n'), null);
  assert.equal(scanSecrets('a: 1\n---\nb: 2\n'), null);
});

test('a literal URL under a webhook-named key is a warning, not an error', () => {
  const text = action('', '      webhookUrl: https://example.com/hooks/build\n');
  assert.deepEqual(rules(text), []);
  const [warning] = validateLocal(text).findings.filter((f) => f.ruleId === 'plaintext-webhook');
  assert.equal(warning.severity, 'warning');
  assert.equal(warning.path, 'steps[0].inputs.webhookUrl');
  assert.match(warning.message, /warning, not an error/);
  assert.doesNotMatch(warning.message, /example\.com/);
  assert.deepEqual(rules(action('', '      webhookUrl: ${{ :secrets:hookUrl }}\n'), 'warning'), []);
  // Known webhook hosts stay errors whatever the key is called.
  const slack = `https://hooks.slack.com/services/${'T0'.repeat(4)}/${'B0'.repeat(4)}/${'x'.repeat(24)}`;
  assert.deepEqual(rules(action('', `      webhookUrl: ${slack}\n`)), ['plaintext-token']);
});

test('anchors, aliases, and merge keys are rejected before any walk', () => {
  // Billion laughs: 9 levels of 10 aliases would expand to 10^9 nodes if walked.
  let bomb = 'name: wf\nsteps: []\na0: &a0 [x, x, x, x, x, x, x, x, x, x]\n';
  for (let i = 1; i <= 9; i++) bomb += `a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(', ')}]\n`;
  const started = Date.now();
  assert.deepEqual(rules(bomb), ['yaml-aliases']);
  assert.ok(Date.now() - started < 1000);

  const circular = validateLocal('name: wf\nsteps:\n  - &s {name: s1, type: action, inputs: {x: [*s]}}\n');
  assert.equal(circular.doc, null);
  assert.deepEqual(circular.findings.map((f) => [f.ruleId, f.category]), [['yaml-aliases', 'yaml']]);

  const merge = validateLocal('name: wf\nsteps:\n  - name: s1\n    type: action\n    <<: {__proto__: {polluted: yes}}\n');
  assert.deepEqual(merge.findings.map((f) => f.ruleId), ['yaml-aliases']);
  assert.match(merge.findings[0].message, /merge key "<<"/);
  assert.equal(typeof merge.findings[0].line, 'number');
  assert.equal({}.polluted, undefined);
});

test('unquoted dates and timestamps stay strings instead of becoming Date objects', () => {
  const [doc] = parseYaml('d: 2024-01-01\nt: 2024-01-01T10:00:00Z\nb: !!binary aGk=\n');
  assert.equal(doc.d, '2024-01-01');
  assert.equal(doc.t, '2024-01-01T10:00:00Z');
  assert.ok(doc.b instanceof Uint8Array);
  assert.deepEqual(errorsOf('name: wf\ndescription: 2024-01-01\nsteps:\n  - name: s\n    type: wait\n    seconds: 1\n'), []);
  const twoDates = (a, b) => `name: wf\ndescription: test\nsteps:\n${[a, b].map((d, i) => `  - name: s${i}\n    type: action\n    action: http.get\n    version: 1\n    inputs:\n      url: https://example.com\n      since: ${d}\n`).join('')}`;
  assert.ok(!validateLocal(twoDates('2024-01-01', '2024-02-02')).findings.some((f) => f.ruleId === 'duplicate-action-call'));
});

test('secret reference syntax', () => {
  assert.equal(checkSecretRef(' :secrets:name '), null);
  assert.equal(checkSecretRef(':secrets:ns:name'), null);
  assert.equal(checkSecretRef(':secrets:ORGANIZATION:ns:name'), null);
  assert.equal(checkSecretRef('.workflowInputs.secretsCount'), null);
  assert.match(checkSecretRef('secrets.name'), /must use the form/);
  assert.match(checkSecretRef('.secrets.name'), /must use the form/);
  assert.match(checkSecretRef(':secrets:a:b:c:d'), /more than 3/);
  assert.match(checkSecretRef(':secrets:TEAM:ns:name'), /scope must be/);
  assert.match(checkSecretRef(':secrets:ns::name'), /invalid segment/);
  assert.deepEqual(rules(action('', '      licenseKey: ${{ secrets.myKey }}\n')), ['secret-ref-format']);
});

test('best-practice info findings', () => {
  assert.deepEqual(rules(VALID.replace('description: Logs a message\n', ''), 'info'), ['missing-description']);

  const http = 'name: wf\ndescription: test\nsteps:\n  - name: get\n    type: action\n    action: http.get\n    version: 1\n    inputs:\n      url: https://example.com\n';
  assert.deepEqual(rules(http, 'info'), ['external-call-error-handling']);
  assert.deepEqual(rules(http.replace('    version: 1\n', '    version: 1\n    ignoreErrors: true\n'), 'info'), []);
  assert.deepEqual(rules(`${http}  - name: fail\n    type: error\n`, 'info'), []);

  const twice = `${action()}  - name: s2\n    type: action\n    action: newrelic.ingest.sendLogs\n    version: 1\n    inputs:\n      logs:\n        - message: hi\n`;
  assert.deepEqual(rules(twice, 'info'), ['duplicate-action-call']);

  const aws = 'name: wf\ndescription: test\nsteps:\n  - name: resize\n    type: action\n    action: aws.execute.api\n    version: 1\n    ignoreErrors: true\n    inputs:\n      region: us-east-1\n      instanceId: i-1234567890abcdef0\n';
  assert.deepEqual(rules(aws, 'info'), ['hardcoded-environment-value', 'hardcoded-environment-value']);
});

test('relatedDocs reflect detected features', () => {
  const yaml = `name: wf
description: test
workflowInputs:
  channel:
    type: String
steps:
  - name: poll
    type: loop
    for:
      in: \${{ [1, 2] }}
      steps:
        - name: fetch
          type: action
          action: http.get
          version: 1
          inputs:
            url: https://example.com
            selectors:
              - name: body
                expression: .responseBody
  - name: notify
    type: action
    action: slack.chat.postMessage
    version: 1
    inputs:
      text: \${{ .steps.fetch.outputs.body }}
`;
  const features = validateLocal(yaml).relatedDocs.map((d) => d.feature);
  assert.deepEqual(features, ['loop', 'selectors', 'workflowInputs', 'dataPassing', 'httpPolling', 'slack']);
  assert.ok(validateLocal(yaml).relatedDocs.every((d) => d.url.startsWith('https://docs.newrelic.com/')));
});

test('valid file exits 0 and sends base64 YAML via GraphQL variables', async () => {
  writeFileSync(join(cwd, 'wf.yaml'), VALID);
  const { code, json } = await run(['wf.yaml']);
  assert.equal(code, 0);
  assert.equal(json.valid, true);
  assert.deepEqual(json.server, { ran: true, valid: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].variables.accountId, 1234);
  assert.equal(Buffer.from(calls[0].variables.definition.yaml, 'base64').toString('utf8'), VALID);
  assert.ok(!calls[0].query.includes('demoWorkflow'));
});

test('server errors become findings and exit 3', async () => {
  writeFileSync(join(cwd, 'wf.yaml'), VALID);
  const { code, json } = await run(['wf.yaml'], { respond: () => ({ body: validationResponse(false, ['steps[0].next must be one of ...']) }) });
  assert.equal(code, 3);
  assert.equal(json.valid, false);
  assert.deepEqual(json.findings.map((f) => [f.category, f.message]), [['server', 'steps[0].next must be one of ...']]);
});

test('GraphQL errors become server findings', async () => {
  writeFileSync(join(cwd, 'wf.yaml'), VALID);
  const { code, json } = await run(['wf.yaml'], { respond: () => ({ body: { errors: [{ message: 'bad definition' }] } }) });
  assert.equal(code, 3);
  assert.deepEqual(json.server, { ran: true, valid: false });
  assert.equal(json.findings[0].message, 'bad definition');
});

test('GraphQL access errors are not definition findings: the server is reported as not run', async () => {
  writeFileSync(join(cwd, 'wf.yaml'), VALID);
  const byClass = await run(['wf.yaml'], { respond: () => ({ body: { errors: [{ message: 'nope', extensions: { errorClass: 'ACCESS_DENIED' } }] } }) });
  assert.equal(byClass.code, 0);
  assert.equal(byClass.json.server.ran, false);
  assert.match(byClass.json.server.error, /nope/);
  assert.deepEqual(byClass.json.findings.map((f) => f.ruleId), ['server-skipped']);
  const byMessage = await run(['wf.yaml'], { respond: () => ({ body: { errors: [{ message: 'You do not have permission to view this account' }] } }) });
  assert.equal(byMessage.code, 0);
  assert.equal(byMessage.json.server.ran, false);
  const definition = await run(['wf.yaml'], { respond: () => ({ body: { errors: [{ message: 'steps[0].next must be one of ...', extensions: { errorClass: 'INVALID_INPUT' } }] } }) });
  assert.equal(definition.code, 3);
  assert.deepEqual(definition.json.server, { ran: true, valid: false });
});

test('a file that is not valid UTF-8 is a usage error, not validated lossily', async () => {
  writeFileSync(join(cwd, 'wf.yaml'), Buffer.from([0x6e, 0x3a, 0x20, 0xe9]));
  const { code, stderr } = await run(['wf.yaml']);
  assert.equal(code, 1);
  assert.match(stderr, /wf\.yaml is not valid UTF-8; re-save it as UTF-8/);
  assert.equal(calls.length, 0);
});

test('API failure falls back to local result with a warning', async () => {
  writeFileSync(join(cwd, 'wf.yaml'), VALID);
  const { code, json, stdout } = await run(['wf.yaml'], { respond: () => ({ body: {}, status: 401 }) });
  assert.equal(code, 0);
  assert.equal(json.server.ran, false);
  assert.match(json.server.error, /401/);
  assert.deepEqual(json.findings.map((f) => f.ruleId), ['server-skipped']);
  assert.ok(!stdout.includes(KEY));
});

test('missing credentials skip the server with a warning', async () => {
  writeFileSync(join(cwd, 'wf.yaml'), VALID);
  const { code, json } = await run(['wf.yaml'], { env: {} });
  assert.equal(code, 0);
  assert.equal(calls.length, 0);
  assert.equal(json.server.ran, false);
  assert.equal(json.summary.warnings, 1);
  const skipped = json.findings.find((f) => f.ruleId === 'server-skipped');
  assert.doesNotMatch(skipped.message, /\.\./, 'no doubled period');
});

test('plaintext secrets: the definition is not sent to the server, and the skip says why', async () => {
  const secret = 'hunter2secretvalue';
  writeFileSync(join(cwd, 'wf.yaml'), VALID.replace('    inputs:\n', `    inputs:\n      password: ${secret}\n`));
  const { code, json, stdout } = await run(['wf.yaml']);
  assert.equal(code, 3);
  assert.equal(calls.length, 0, 'no NerdGraph call was made');
  assert.equal(json.server.ran, false);
  assert.match(json.server.error, /plaintext secrets/);
  assert.ok(json.findings.some((f) => f.ruleId === 'plaintext-secret'));
  assert.ok(!stdout.includes(secret));
});

test('--local-only and unparseable YAML skip the server', async () => {
  writeFileSync(join(cwd, 'wf.yaml'), VALID);
  const local = await run(['wf.yaml', '--local-only']);
  assert.equal(local.code, 0);
  assert.equal(local.json.summary.warnings, 0);
  writeFileSync(join(cwd, 'bad.yaml'), 'name: [oops\n');
  const bad = await run(['bad.yaml']);
  assert.equal(bad.code, 3);
  assert.equal(calls.length, 0);
});

test('local errors still run the server', async () => {
  writeFileSync(join(cwd, 'wf.yaml'), VALID.replace('demoWorkflow', '1bad'));
  const { code } = await run(['wf.yaml']);
  assert.equal(code, 3);
  assert.equal(calls.length, 1);
});

test('name resolves by filename, then by name field, case-insensitively', async () => {
  writeWorkflow('DemoWorkflow.yaml', VALID);
  const byFile = await run(['demoworkflow', '--local-only']);
  assert.equal(byFile.code, 0);
  assert.equal(byFile.json.file, join(cwd, 'workflows', 'DemoWorkflow.yaml'));

  writeWorkflow('draft.yml', VALID.replace('demoWorkflow', 'ec2Resize'));
  const byName = await run(['EC2RESIZE', '--local-only']);
  assert.equal(byName.json.file, join(cwd, 'workflows', 'draft.yml'));
});

test('ambiguous or missing names are usage errors', async () => {
  writeWorkflow('a.yaml', VALID);
  writeWorkflow('b.yaml', VALID);
  const ambiguous = await run(['demoWorkflow']);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /Multiple files match/);
  const missing = await run(['nope']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No workflow named "nope"/);
});

test('--stdin reads YAML from stdin', async () => {
  const { code, json } = await run(['--stdin', '--local-only'], { stdin: Readable.from([VALID]) });
  assert.equal(code, 0);
  assert.equal(json.file, '<stdin>');
});

test('usage errors exit 1', async () => {
  assert.equal((await run([])).code, 1);
  assert.equal((await run(['a.yaml', '--stdin'])).code, 1);
  assert.equal((await run(['missing.yaml'])).code, 1);
  writeFileSync(join(cwd, 'wf.yaml'), VALID);
  assert.equal((await run(['wf.yaml', '--account', 'abc'])).code, 1);
  assert.equal((await run(['--help'])).code, 0);
});
