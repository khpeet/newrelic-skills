import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { discoverRuns } from '../../../tools/run-evals.mjs';
import triggers from '../../../tools/evals/kinds/triggers.mjs';
import { makeRepo, saveTriggerRun, write } from './helpers.mjs';

const realRoot = new URL('../../../', import.meta.url).pathname;
const Q = [{ query: 'say hi to me', should_trigger: true }, { query: 'unrelated', should_trigger: false }];
const discover = (data) => discoverRuns(makeRepo({ triggers: data }), { kinds: ['triggers'] });
const grade = (reps, { shouldTrigger = true } = {}) => {
  const root = makeRepo({ triggers: { hello: [{ query: 'q', should_trigger: shouldTrigger }] } });
  const dir = saveTriggerRun(root, { reps, shouldTrigger });
  return triggers.grade(dir, discoverRuns(root, { kinds: ['triggers'] })[0]);
};
const hit = { skills: ['demo-plugin:hello'] };
const miss = { skills: [] };

test('discover: one with_skill run per query, 1-based ids, labels and output directories; none without a triggers.json', () => {
  const runs = discover({ hello: Q });
  assert.deepEqual(runs.map((r) => [r.kind, r.skill, r.caseId, r.variant, r.shouldTrigger]), [['triggers', 'hello', 1, 'with_skill', true], ['triggers', 'hello', 2, 'with_skill', false]]);
  assert.deepEqual(runs.map((r) => r.label), ['demo/hello q-1 should trigger', 'demo/hello q-2 should-not trigger']);
  assert.deepEqual(runs.map((r) => triggers.outDir(r)), [join('triggers', 'hello', 'q-1'), join('triggers', 'hello', 'q-2')]);
  assert.equal(runs[0].query, 'say hi to me');
  assert.deepEqual(discoverRuns(makeRepo(), { kinds: ['triggers'] }), []);
});

test('discover: reports every problem in triggers.json in one error', () => {
  const root = makeRepo({ triggers: { ghost: Q, hello: [{ query: '', should_trigger: true }, { query: 'x', should_trigger: 'yes' }, { query: 'x', should_trigger: true, extra: 1 }, 'str'] } });
  assert.throws(() => discoverRuns(root, { kinds: ['triggers'] }), (e) => {
    for (const re of [/"ghost" is not an installed skill/, /hello\[0\]: "query" must be a non-empty string/, /hello\[1\]: "should_trigger" must be a boolean/, /hello\[2\]: unknown key "extra"/, /hello\[3\]: must be an object/]) assert.match(e.message, re);
    return true;
  });
  assert.throws(() => discover({ hello: [] }), /"hello" must be a non-empty array/);
  assert.throws(() => discover([]), /must be an object/);
  write(join(root, 'evals', 'demo', 'triggers.json'), '{oops');
  assert.throws(() => discoverRuns(root, { kinds: ['triggers'] }), /evals\/demo\/triggers\.json/);
});

test('discover: runs carry the family config, including triggerFiles', () => {
  const root = makeRepo({ triggers: { hello: Q }, config: { plugin: 'demo-plugin', install: ['demo'], triggerFiles: ['fixtures/c1/workflows/a.yaml'] } });
  const runs = discoverRuns(root, { kinds: ['triggers'] });
  assert.deepEqual(runs.map((r) => r.config.triggerFiles), [['fixtures/c1/workflows/a.yaml'], ['fixtures/c1/workflows/a.yaml']]);
  assert.deepEqual(discover({ hello: Q })[0].config.triggerFiles, []);
});

test('the real repo: every skill of a family with a triggers.json has at least 5 queries of both kinds', () => {
  const runs = discoverRuns(realRoot, { kinds: ['triggers'] });
  const bySkill = Object.groupBy(runs, (r) => r.skill);
  const dirs = (path) => readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory());
  const expected = dirs(join(realRoot, 'evals'))
    .filter((f) => existsSync(join(realRoot, 'evals', f.name, 'triggers.json')))
    .flatMap((f) => dirs(join(realRoot, 'skills', f.name)).filter((s) => existsSync(join(realRoot, 'skills', f.name, s.name, 'SKILL.md'))).map((s) => s.name));
  assert.ok(expected.length > 0);
  assert.deepEqual(Object.keys(bySkill).sort(), expected.sort());
  for (const [skill, list] of Object.entries(bySkill)) {
    assert.ok(list.length >= 5, `${skill}: ${list.length} queries, need at least 5`);
    assert.ok(list.filter((r) => r.shouldTrigger).length >= 2, `${skill}: need at least 2 should-trigger queries`);
    assert.ok(list.filter((r) => !r.shouldTrigger).length >= 2, `${skill}: need at least 2 should-not-trigger queries`);
  }
});

test('plan: --max-turns 2, a capped budget, no Bash, the query as the prompt, and the repetition count', () => {
  const [run] = discover({ hello: Q });
  const { args, repeat } = triggers.plan(run, { env: {}, model: 'sonnet', maxBudgetUsd: 2, runs: 3 });
  assert.equal(repeat, 3);
  assert.equal(args[1], 'say hi to me');
  assert.equal(args[args.indexOf('--max-turns') + 1], '2');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '0.25');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.ok(args.includes('--plugin-dir'));
  assert.doesNotMatch(args[args.indexOf('--allowedTools') + 1], /Bash/);
  assert.ok(!args.includes('--disable-slash-commands'));
  assert.equal(triggers.plan(run, { env: {}, maxBudgetUsd: 0.1, runs: 1 }).args[triggers.plan(run, { env: {}, maxBudgetUsd: 0.1, runs: 1 }).args.indexOf('--max-budget-usd') + 1], '0.1');
});

test('grade: should-trigger passes above 0.5, should-not-trigger below 0.5, exactly 0.5 fails both ways', () => {
  assert.equal(grade([hit, hit, miss]).passed, true);
  assert.equal(grade([hit, miss]).passed, false);
  assert.equal(grade([hit, miss, miss]).passed, false);
  assert.equal(grade([hit, miss, miss], { shouldTrigger: false }).passed, true);
  assert.equal(grade([hit, miss], { shouldTrigger: false }).passed, false);
  assert.equal(grade([hit, hit], { shouldTrigger: false }).passed, false);
  const g = grade([hit, hit, miss]);
  assert.deepEqual([g.trigger_rate, g.valid_runs, g.triggered_runs, g.summary], [0.6667, 3, 2, { PASS: 1, FAIL: 0, PARTIAL: 0, MANUAL: 0 }]);
  assert.equal(g.cost_usd, 0.15);
  assert.equal(g.total_tokens, 300);
  assert.equal(g.run.error, null);
});

test('grade: skill names are normalized to the part after the last colon; other skills are recorded', () => {
  const g = grade([{ skills: ['hello', 'a:b:other'] }, { skills: ['plugin:hello', 'plugin:third', 'other'] }]);
  assert.deepEqual(g.runs.map((r) => [r.triggered, r.skills_called]), [[true, ['hello', 'other']], [true, ['hello', 'third', 'other']]]);
  assert.deepEqual(g.other_skills, ['other', 'third']);
  assert.equal(grade([{ skills: ['other'] }]).triggered_runs, 0);
});

test('grade: a max-turns stop is a normal end; real errors are not counted as valid runs', () => {
  const ok = grade([hit, hit]);
  assert.equal(ok.run.error, null);
  assert.ok(ok.runs.every((r) => r.max_turns));
  const mixed = grade([hit, { ...hit, result: { subtype: 'success', is_error: true, terminal_reason: 'completed', result: 'API Error: 500' }, meta: { exitCode: 1 } }, hit]);
  assert.deepEqual([mixed.valid_runs, mixed.trigger_rate, mixed.passed], [2, 1, true]);
  assert.match(mixed.run.error, /1 of 3 runs failed: claude reported an error: API Error: 500/);
  const timedOut = grade([{ ...hit, meta: { timedOut: true } }]);
  assert.deepEqual([timedOut.valid_runs, timedOut.trigger_rate, timedOut.passed], [0, null, false]);
  assert.match(timedOut.run.error, /timed out/);
  assert.equal(grade([{ ...hit, meta: { spawnError: 'ENOENT' } }]).run.error, '1 of 1 runs failed: could not start claude: ENOENT');
});

test('progress: one line with the rate, the expectation, and sibling skills', () => {
  assert.equal(triggers.progress(grade([hit, hit, miss])), 'triggered 2/3 (expected trigger) PASS');
  assert.equal(triggers.progress(grade([{ skills: ['demo:other'] }], { shouldTrigger: false })), 'triggered 0/1 (expected no trigger) PASS; also called other');
  assert.equal(triggers.progress(grade([{ ...hit, meta: { timedOut: true } }])), 'triggered n/a (expected trigger) FAIL');
});

test('summarize: accuracy, confusion counts, precision and recall, sibling routing, spend; null where the denominator is 0', () => {
  const g = (o) => ({ skill: 'a', query_id: 1, query: 'q', should_trigger: true, valid_runs: 3, trigger_rate: 1, passed: true, other_skills: [], cost_usd: 0.1, total_tokens: 10, ...o });
  const out = triggers.summarize([
    g({ query_id: 2 }),
    g({ query_id: 1, trigger_rate: 0, passed: false, other_skills: ['b'] }),
    g({ query_id: 3, should_trigger: false, trigger_rate: 0, passed: true, other_skills: ['b'] }),
    g({ query_id: 4, should_trigger: false, trigger_rate: 1, passed: false }),
    g({ query_id: 5, trigger_rate: null, valid_runs: 0, passed: false }),
    g({ skill: 'neg', should_trigger: false, trigger_rate: 0, passed: true }),
  ]);
  const a = out.a;
  assert.deepEqual([a.queries, a.correct, a.accuracy, a.tp, a.fp, a.tn, a.fn, a.invalid, a.precision, a.recall], [5, 2, 0.4, 1, 1, 1, 1, 1, 0.5, 0.5]);
  assert.deepEqual([a.missed_to, a.confusion, a.cost_usd, a.total_tokens], [{ b: 1 }, { b: 1 }, 0.5, 50]);
  assert.deepEqual(a.per_query.map((q) => q.id), [1, 2, 3, 4, 5]);
  assert.equal(a.per_query[0].trigger_rate, 0);
  assert.deepEqual([out.neg.tp, out.neg.precision, out.neg.recall, out.neg.accuracy], [0, null, null, 1]);
});
