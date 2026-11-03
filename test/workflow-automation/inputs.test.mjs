import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRunInputs, parseInputArgs } from '../../shared/workflow-automation/inputs.mjs';
import { UsageError } from '../../shared/workflow-automation/nerdgraph.mjs';

const INPUTS = {
  message: { type: 'String', validations: [{ type: 'maxLength', errorMessage: 'Message too long', length: 5 }] },
  zone: { type: 'String', required: false, validations: [{ type: 'regex', errorMessage: 'Bad zone', pattern: '^[A-Z][a-z]+/[A-Za-z_]+$' }] },
  count: { type: 'Int', defaultValue: 1, validations: [{ type: 'minIntValue', errorMessage: 'Too small', minValue: 1 }, { type: 'maxIntValue', errorMessage: 'Too big', maxValue: 10 }] },
  ratio: { type: 'Float', required: false },
  dryRun: { type: 'Boolean', required: false },
  level: { type: 'Enum', enumValues: ['low', 'high'], required: false },
  tags: { type: 'List', required: false, validations: [{ type: 'maxLength', errorMessage: 'Too many tags', length: 2 }] },
  labels: { type: 'Map', required: false },
};

const errors = (findings) => findings.filter((f) => f.severity === 'error').map((f) => [f.ruleId, f.path]);

test('parseInputArgs: splits on the first "=", merges JSON, keeps JSON types', () => {
  assert.deepEqual(parseInputArgs(['a=1', 'url=https://x?y=z', 'empty='], '{"tags": ["a"], "n": 2}'), {
    a: '1', url: 'https://x?y=z', empty: '', tags: ['a'], n: 2,
  });
  assert.deepEqual(parseInputArgs(), {});
});

test('parseInputArgs: usage errors for bad pairs, bad JSON, non-object JSON, and duplicates', () => {
  assert.throws(() => parseInputArgs(['novalue']), (err) => err instanceof UsageError && /key=value/.test(err.message));
  assert.throws(() => parseInputArgs(['=v']), /key=value/);
  assert.throws(() => parseInputArgs([], '{bad'), /not valid JSON/);
  assert.throws(() => parseInputArgs([], '[1]'), /must be a JSON object/);
  assert.throws(() => parseInputArgs(['a=1'], '{"a": 2}'), /"a" is given more than once/);
  assert.throws(() => parseInputArgs(['a=1', 'a=2']), /more than once/);
});

test('checkRunInputs: valid values become wire strings; defaults listed but marked as defaults', () => {
  const supplied = { message: 'hi', zone: 'America/Los_Angeles', ratio: '0.5', dryRun: 'true', level: 'high', tags: '["a","b"]', labels: { env: 'prod' } };
  const { resolved, findings } = checkRunInputs(INPUTS, supplied);
  assert.deepEqual(findings, []);
  assert.deepEqual(resolved, [
    { key: 'message', value: 'hi', source: 'supplied' },
    { key: 'zone', value: 'America/Los_Angeles', source: 'supplied' },
    { key: 'count', value: 1, source: 'default' },
    { key: 'ratio', value: '0.5', source: 'supplied' },
    { key: 'dryRun', value: 'true', source: 'supplied' },
    { key: 'level', value: 'high', source: 'supplied' },
    { key: 'tags', value: '["a","b"]', source: 'supplied' },
    { key: 'labels', value: '{"env":"prod"}', source: 'supplied' },
  ]);
});

test('checkRunInputs: JSON-typed values are accepted and stringified', () => {
  const { resolved, findings } = checkRunInputs(INPUTS, { message: 'hi', count: 3, dryRun: false, tags: ['x'] });
  assert.deepEqual(findings, []);
  assert.deepEqual(resolved.filter((r) => r.source === 'supplied').map((r) => r.value), ['hi', '3', 'false', '["x"]']);
});

test('checkRunInputs: unknown, missing-required, type, enum, and validation errors', () => {
  const { findings } = checkRunInputs(INPUTS, {
    message: 'far too long', bogus: 'x', zone: 'nowhere', count: '11', ratio: 'abc', dryRun: 'yes', level: 'mid', tags: '["a","b","c"]', labels: '[1]',
  });
  assert.deepEqual(errors(findings), [
    ['unknown-input', 'bogus'],
    ['input-validation', 'message'],
    ['input-validation', 'zone'],
    ['input-validation', 'count'],
    ['input-type', 'ratio'],
    ['input-type', 'dryRun'],
    ['input-type', 'level'],
    ['input-validation', 'tags'],
    ['input-type', 'labels'],
  ]);
  assert.match(findings.find((f) => f.path === 'message').message, /Input "message": Message too long/);
  assert.match(findings.find((f) => f.path === 'level').message, /must be one of: low, high/);
  assert.match(findings.find((f) => f.path === 'bogus').message, /Declared inputs: message, zone/);

  const missing = checkRunInputs(INPUTS, {});
  assert.deepEqual(errors(missing.findings), [['missing-input', 'message']]);
  assert.deepEqual(errors(checkRunInputs(INPUTS, { message: 'hi', count: '0' }).findings), [['input-validation', 'count']]);
  assert.deepEqual(errors(checkRunInputs(INPUTS, { message: 'hi', count: '1.5' }).findings), [['input-type', 'count']]);
});

test('checkRunInputs: no declared inputs, and an uncompilable regex is a warning', () => {
  assert.match(checkRunInputs(undefined, { a: '1' }).findings[0].message, /declares no inputs/);
  const { findings, resolved } = checkRunInputs({ p: { type: 'String', validations: [{ type: 'regex', errorMessage: 'x', pattern: '(?<' }] } }, { p: 'v' });
  assert.deepEqual(findings.map((f) => [f.severity, f.ruleId]), [['warning', 'input-validation-unchecked']]);
  assert.equal(resolved[0].value, 'v');
});

test('checkRunInputs: a catastrophic regex from the definition is skipped after a timeout, not run to completion', { timeout: 5000 }, () => {
  const inputs = { p: { type: 'String', validations: [{ type: 'regex', errorMessage: 'x', pattern: '^(a+)+$' }] } };
  const started = Date.now();
  const { findings, resolved } = checkRunInputs(inputs, { p: `${'a'.repeat(40)}b` });
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(findings.map((f) => [f.severity, f.ruleId]), [['warning', 'input-validation-unchecked']]);
  assert.match(findings[0].message, /took over \d+ ms to check locally/);
  assert.equal(resolved[0].value, `${'a'.repeat(40)}b`);
  // The shared context is reusable afterwards, and ordinary regexes still pass and fail.
  const zone = { type: 'String', validations: [{ type: 'regex', errorMessage: 'Bad zone', pattern: '^[A-Z][a-z]+/[A-Za-z_]+$' }] };
  assert.deepEqual(checkRunInputs({ zone }, { zone: 'Europe/Paris' }).findings, []);
  assert.equal(checkRunInputs({ zone }, { zone: 'nope' }).findings[0].message.includes('Bad zone'), true);
});

test('checkRunInputs: a supplied value that looks like a token is an error and is never echoed', () => {
  // Built at runtime so no real-format key sits in the source.
  const nrak = `NRAK-${'A'.repeat(27)}`;
  const inputs = { apiKey: { type: 'String' }, note: { type: 'String' } };
  const { findings, resolved } = checkRunInputs(inputs, { apiKey: nrak, note: 'hello' });
  assert.deepEqual(findings.map((f) => [f.severity, f.ruleId, f.path]), [['error', 'input-plaintext-token', 'apiKey']]);
  assert.match(findings[0].message, /hardcoded New Relic API key/);
  assert.ok(!findings[0].message.includes(nrak));
  assert.deepEqual(resolved, [{ key: 'apiKey', value: '[REDACTED]', source: 'supplied' }, { key: 'note', value: 'hello', source: 'supplied' }]);
  const list = checkRunInputs({ headers: { type: 'List' } }, { headers: [`Bearer ${'x'.repeat(20)}`] });
  assert.equal(list.findings[0].ruleId, 'input-plaintext-token');
  assert.equal(checkRunInputs({ note: { type: 'String', defaultValue: nrak } }, {}).findings.length, 0);
  const lower = checkRunInputs({ apiKey: { type: 'String' } }, { apiKey: `NRAK-${'a'.repeat(27)}` });
  assert.equal(lower.findings[0].ruleId, 'input-plaintext-token');
});

test('checkRunInputs: an Int given as a JSON number must be a safe integer; larger values go in as strings', () => {
  const inputs = { n: { type: 'Int' } };
  const big = checkRunInputs(inputs, { n: 1e21 });
  assert.deepEqual(big.findings.map((f) => [f.ruleId, f.path]), [['input-type', 'n']]);
  assert.match(big.findings[0].message, /safe integer/);
  assert.deepEqual(checkRunInputs(inputs, { n: 5 }).resolved, [{ key: 'n', value: '5', source: 'supplied' }]);
  assert.deepEqual(checkRunInputs(inputs, { n: '99999999999999999999' }).resolved, [{ key: 'n', value: '99999999999999999999', source: 'supplied' }]);
});
