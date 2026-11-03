import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { main as build } from '../../skills/workflow-automation/build-workflow/scripts/build-workflow.mjs';
import { main as fetchWf } from '../../skills/workflow-automation/fetch-workflow/scripts/fetch-workflow.mjs';
import { main as publish } from '../../skills/workflow-automation/publish-workflow/scripts/publish-workflow.mjs';
import { main as runWf } from '../../skills/workflow-automation/run-workflow/scripts/run-workflow.mjs';
import { main as validate } from '../../skills/workflow-automation/validate-workflow/scripts/validate-workflow.mjs';

const env = { NEW_RELIC_API_KEY: 'NRAK-SECRETKEY123', NEW_RELIC_ACCOUNT_ID: '1234' };
const YAML = 'name: wf\ndescription: test\nsteps:\n  - name: w\n    type: wait\n    seconds: 1\n';

// Agents read this output, so each script prints one line of compact JSON (no indentation).
for (const [label, main, argv, extra] of [
  ['build-workflow', build, ['env'], {}],
  ['fetch-workflow', fetchWf, ['env'], {}],
  ['publish-workflow', publish, ['env'], {}],
  ['run-workflow', runWf, ['env'], {}],
  ['validate-workflow', validate, ['--stdin', '--local-only'], { stdin: Readable.from([YAML]) }],
]) {
  test(`${label}: stdout is a single line of compact JSON`, async () => {
    const out = { text: '', write(s) { this.text += s; } };
    const err = { text: '', write(s) { this.text += s; } };
    await main(argv, { env, stdout: out, stderr: err, cwd: mkdtempSync(join(tmpdir(), 'fmt-')), ...extra });
    assert.ok(out.text.endsWith('\n'));
    const body = out.text.slice(0, -1);
    assert.ok(!body.includes('\n'), body);
    assert.equal(body, JSON.stringify(JSON.parse(body)));
  });
}
