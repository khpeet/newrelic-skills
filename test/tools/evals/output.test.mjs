import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { discoverRuns } from '../../../tools/run-evals.mjs';
import output from '../../../tools/evals/kinds/output.mjs';
import { makeRepo, saveRun, write } from './helpers.mjs';

const SCRIPT = '/private/var/folders/xx/nr-evals-AAAA/plugin/skills/demo/hello/scripts/hello.mjs';

test('discover: one with_skill and one without_skill run per case, with labels and output directories', () => {
  const root = makeRepo();
  const runs = discoverRuns(root);
  assert.deepEqual(runs.map((r) => r.label), ['demo/hello eval-1 with_skill', 'demo/hello eval-1 without_skill']);
  assert.deepEqual(runs.map((r) => output.outDir(r)), [join('hello', 'eval-1', 'with_skill'), join('hello', 'eval-1', 'without_skill')]);
  assert.equal(runs[0].case.prompt, 'say hi');
  assert.deepEqual(runs[0].skills.map((s) => `${s.family}/${s.name}`), ['demo/hello']);
});

test('discover: reports every problem in the eval data in one error', () => {
  const root = makeRepo({ checks: [{ assertion: 9, type: 'cmd_matches', pattern: '(' }] });
  write(join(root, 'evals', 'demo', 'ghost', 'evals.json'), JSON.stringify({ skill_name: 'ghost', evals: [] }));
  write(
    join(root, 'evals', 'demo', 'hello', 'evals.json'),
    JSON.stringify({
      skill_name: 'wrong',
      evals: [
        { id: 1, prompt: 'p', files: ['fixtures/c1/missing.yaml'], assertions: ['a'], checks: [{ assertion: 9, type: 'cmd_matches', pattern: '(' }] },
        { id: 1, prompt: '', files: 'x', assertions: [] },
      ],
    }),
  );
  assert.throws(
    () => discoverRuns(root),
    (e) => {
      for (const re of [/ghost\/evals\.json: skills\/demo\/ghost\/SKILL\.md does not exist/, /"skill_name" must be "hello"/, /file "fixtures\/c1\/missing\.yaml" does not exist/, /"assertion" must be an integer from 0 to 0/, /not a valid pattern/, /duplicate id 1/, /"prompt" must be a non-empty string/, /"files" must be an array/, /"assertions" must be a non-empty array/]) {
        assert.match(e.message, re);
      }
      return true;
    },
  );
});

test('plan: redacted claude arguments, with the plugin only for with_skill', () => {
  const [withSkill, baseline] = discoverRuns(makeRepo());
  const ctx = { env: { CLAUDE_CONFIG_DIR: '/nonexistent' }, model: 'sonnet', maxBudgetUsd: 3 };
  const a = output.plan(withSkill, ctx).args;
  assert.equal(a[1], 'say hi');
  assert.ok(a.includes('--plugin-dir'));
  assert.deepEqual(a.slice(-4), ['--max-budget-usd', '3', '--model', 'sonnet']);
  assert.ok(!output.plan(baseline, ctx).args.includes('--plugin-dir'));
});

test('grade: grades saved artifacts against the case checks and reports the run state', () => {
  const root = makeRepo();
  const [run] = discoverRuns(root);
  const dir = saveRun(root, { commands: [`node ${SCRIPT}`], final: 'hi there' });
  const grading = output.grade(dir, run);
  assert.deepEqual(grading.summary, { PASS: 2, FAIL: 0, PARTIAL: 0, MANUAL: 1 });
  assert.deepEqual(grading.assertions.map((a) => a.result), ['PASS', 'PASS', 'MANUAL']);
  assert.equal(grading.final_response, 'hi there');
  assert.deepEqual(grading.run, { error: null, is_error: false, terminal_reason: 'completed', exit_code: 0, timed_out: false });
  assert.equal(grading.eval_id, 1);
  assert.equal(grading.variant, 'with_skill');
});

test('grade: guard assertions are flagged, counted apart in guard_summary and scored_summary, and still in summary', () => {
  const root = makeRepo({ guards: [1, 2] });
  const [run] = discoverRuns(root);
  const grading = output.grade(saveRun(root, { commands: ['ls'], final: 'hi' }), run);
  assert.deepEqual(grading.assertions.map((a) => [a.result, a.guard]), [['FAIL', false], ['PASS', true], ['MANUAL', true]]);
  assert.deepEqual(grading.summary, { PASS: 1, FAIL: 1, PARTIAL: 0, MANUAL: 1 });
  assert.deepEqual(grading.guard_summary, { PASS: 1, FAIL: 0, PARTIAL: 0, MANUAL: 1 });
  assert.deepEqual(grading.scored_summary, { PASS: 0, FAIL: 1, PARTIAL: 0, MANUAL: 0 });
});

test('discover: rejects out-of-range or repeated guards', () => {
  assert.throws(() => discoverRuns(makeRepo({ guards: [3, 1, 1] })), (e) => /"guards" entry 3 must be an integer from 0 to 2/.test(e.message) && /must not repeat/.test(e.message));
  assert.throws(() => discoverRuns(makeRepo({ guards: 1 })), /"guards" must be an array/);
  assert.equal(discoverRuns(makeRepo({ guards: [0, 2] })).length, 2);
});

test('discover: a case env is validated up front (only NEW_RELIC_API_KEY, only NRAK-INVALID values), and the value is never in the error', () => {
  const dummy = 'NRAK-INVALID-EVAL-DUMMY-KEY-0000000000';
  assert.equal(discoverRuns(makeRepo({ env: { NEW_RELIC_API_KEY: dummy } })).length, 2);
  assert.deepEqual(discoverRuns(makeRepo({ env: { NEW_RELIC_API_KEY: dummy } })).map((r) => r.case.env), [{ NEW_RELIC_API_KEY: dummy }, { NEW_RELIC_API_KEY: dummy }]);
  const real = `NRAK-${'A1'.repeat(13)}Z`;
  for (const [env, re] of [
    [{ NEW_RELIC_API_KEY: real }, /evals\[0\]: "env" NEW_RELIC_API_KEY must be a value starting with NRAK-INVALID/],
    [{ NEW_RELIC_ACCOUNT_ID: '1' }, /"env" may only set NEW_RELIC_API_KEY, not "NEW_RELIC_ACCOUNT_ID"/],
    [{ NEW_RELIC_API_KEY: 5 }, /must be a string/],
    ['NRAK-INVALID-X', /"env" must be an object/],
  ]) {
    assert.throws(() => discoverRuns(makeRepo({ env })), (e) => re.test(e.message) && !e.message.includes(real), JSON.stringify(env));
  }
});

test('plan: a case env shows only the variable names; the value is not in the plan', () => {
  const dummy = 'NRAK-INVALID-EVAL-DUMMY-KEY-0000000000';
  const [withSkill] = discoverRuns(makeRepo({ env: { NEW_RELIC_API_KEY: dummy } }));
  const plan = output.plan(withSkill, { env: { CLAUDE_CONFIG_DIR: '/nonexistent' }, maxBudgetUsd: 1 });
  assert.deepEqual(plan.envNames, ['NEW_RELIC_API_KEY']);
  assert.ok(!JSON.stringify(plan).includes(dummy));
  assert.deepEqual(output.plan(discoverRuns(makeRepo())[0], { env: { CLAUDE_CONFIG_DIR: '/nonexistent' }, maxBudgetUsd: 1 }).envNames, []);
});

test('grade: FAIL when the script was not run or the fixture changed; run errors are reported', () => {
  const root = makeRepo();
  const [run] = discoverRuns(root);
  const dir = saveRun(root, { commands: ['ls'], projectFiles: { 'workflows/a.yaml': 'name: changed\n' }, result: { is_error: true }, final: 'API Error: 500' });
  const grading = output.grade(dir, run);
  assert.deepEqual(grading.assertions.map((a) => a.result), ['FAIL', 'FAIL', 'MANUAL']);
  assert.match(grading.run.error, /API Error: 500/);
});

test('grade: picks up edited checks (regrade) because it reads the current case, not the saved one', () => {
  const root = makeRepo();
  const dir = saveRun(root, { commands: ['ls'] });
  const [before] = discoverRuns(root);
  assert.equal(output.grade(dir, before).assertions[0].result, 'FAIL');
  write(join(root, 'evals', 'demo', 'hello', 'evals.json'), JSON.stringify({ skill_name: 'hello', evals: [{ id: 1, prompt: 'say hi', files: ['fixtures/c1/workflows/a.yaml'], assertions: ['ran ls', 'x', 'y'], checks: [{ assertion: 0, type: 'cmd_matches', pattern: '^ls$' }] }] }));
  const [after] = discoverRuns(root);
  assert.equal(output.grade(dir, after).assertions[0].result, 'PASS');
});
