import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { UsageError } from '../../shared/workflow-automation/nerdgraph.mjs';
import { readTarget, validateAll } from '../../shared/workflow-automation/validation.mjs';

const env = { NEW_RELIC_API_KEY: 'NRAK-SECRETKEY123', NEW_RELIC_ACCOUNT_ID: '1234' };
const VALID = 'name: wf\ndescription: test\nsteps:\n  - name: w\n    type: wait\n    seconds: 1\n';
const serverReply = (errors) => async () => new Response(JSON.stringify({
  data: { actor: { account: { workflowAutomation: { workflowDefinitionValidation: { valid: errors.length === 0, errors: errors.map((message) => ({ message })) } } } } },
}), { status: 200 });

test('validateAll --local-only: local findings only, server reported as skipped', async () => {
  const result = await validateAll(VALID.replace('description: test\n', ''), { env, localOnly: true });
  assert.equal(result.doc.name, 'wf');
  assert.deepEqual(result.server, { ran: false, error: 'skipped (--local-only)' });
  assert.deepEqual(result.summary, { errors: 0, warnings: 0, info: 1 });
  assert.ok(Array.isArray(result.relatedDocs));
});

test('validateAll: YAML that does not parse skips the server', async () => {
  const result = await validateAll('name: [unclosed', { env });
  assert.equal(result.doc, null);
  assert.deepEqual(result.server, { ran: false, error: 'skipped (YAML did not parse)' });
  assert.equal(result.summary.errors, 1);
});

test('validateAll merges server findings and counts severities', async () => {
  const result = await validateAll(VALID, { env, fetchImpl: serverReply(['steps[0].next is wrong']) });
  assert.deepEqual(result.server, { ran: true, valid: false });
  assert.deepEqual(result.findings.map((f) => [f.category, f.message]), [['server', 'steps[0].next is wrong']]);
  assert.deepEqual(result.summary, { errors: 1, warnings: 0, info: 0 });
});

test('readTarget: exactly one of a target or --stdin; strict UTF-8 for both', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rt-'));
  mkdirSync(join(cwd, 'workflows'));
  writeFileSync(join(cwd, 'workflows', 'wf.yaml'), VALID);
  assert.deepEqual(await readTarget({}, ['wf'], null, cwd, 'USAGE'), { file: join(cwd, 'workflows', 'wf.yaml'), text: VALID });
  assert.deepEqual(await readTarget({ stdin: true }, [], Readable.from([VALID]), cwd, 'USAGE'), { file: '<stdin>', text: VALID });
  await assert.rejects(readTarget({ stdin: true }, ['wf'], null, cwd, 'USAGE-TEXT'), (err) => err instanceof UsageError && err.message.includes('USAGE-TEXT'));
  await assert.rejects(readTarget({}, [], null, cwd, 'USAGE'), UsageError);
  writeFileSync(join(cwd, 'workflows', 'bad.yaml'), Buffer.from([0x6e, 0x3a, 0x20, 0xe9]));
  await assert.rejects(readTarget({}, ['bad'], null, cwd, 'USAGE'), /bad\.yaml is not valid UTF-8; re-save it as UTF-8/);
});
