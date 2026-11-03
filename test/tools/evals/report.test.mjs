import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, renderSkill } from '../../../tools/evals/report.mjs';
import { capture, write } from './helpers.mjs';

const A = (index, result, { guard = false, text = `assertion ${index}`, evidence = [] } = {}) => ({ index, text, guard, result, evidence });

// One saved iteration (distinct skill/id/variant per run, since they name the saved directory): `runs` is [{skill, id, variant, model, assertions, cost, tokens}]; `triggers` adds a trigger roll-up.
function saveIteration(root, n, runs, { triggers, generatedAt = '2026-10-14T19:30:00.000Z' } = {}) {
  const base = join(root, 'evals', 'workspace', 'demo', `iteration-${n}`);
  const records = runs.map((r) => {
    const dir = join('evals', 'workspace', 'demo', `iteration-${n}`, r.skill, `eval-${r.id}`, r.variant);
    write(join(root, dir, 'grading.json'), JSON.stringify({ assertions: r.assertions, run: { error: null } }));
    write(join(root, dir, 'meta.json'), JSON.stringify({ model: r.model }));
    write(join(root, dir, 'timing.json'), JSON.stringify({ total_tokens: r.tokens, total_cost_usd: r.cost }));
    return { family: 'demo', kind: 'output', skill: r.skill, id: r.id, variant: r.variant, dir, cost_usd: r.cost };
  });
  const summary = { family: 'demo', generatedAt, iteration: n, runs: records, ...(triggers && { kinds: { triggers: triggers.bySkill } }) };
  write(join(base, 'summary.json'), JSON.stringify(summary));
  if (triggers) write(join(base, 'triggers', 'hello', 'q-1', 'meta.json'), JSON.stringify({ model: triggers.model, runs: 3 }));
}

const run = (variant, model, assertions, extra = {}) => ({ skill: 'hello', id: 1, variant, model, assertions, cost: 0.2, tokens: 2000, ...extra });
const ASSERTIONS_WITH = [A(0, 'PASS'), A(1, 'FAIL', { text: 'regex miss', evidence: [{ type: 'final_matches', pass: false, evidence: 'final response did not match /x/' }] }), A(2, 'PARTIAL'), A(3, 'PASS', { guard: true }), A(4, 'MANUAL')];
const ASSERTIONS_WITHOUT = [A(0, 'FAIL'), A(1, 'FAIL'), A(2, 'FAIL'), A(3, 'PASS', { guard: true }), A(4, 'MANUAL')];
const TRIGGERS = { model: 'claude-sonnet-5-5', bySkill: { hello: { queries: 4, correct: 3, per_query: [{ id: 1, should_trigger: true, trigger_rate: 1, passed: true }, { id: 2, should_trigger: true, trigger_rate: 0.3333, passed: false }, { id: 3, should_trigger: false, trigger_rate: 0.3333, passed: true }, { id: 4, should_trigger: false, trigger_rate: 0, passed: true }], confusion: { other: 1 } } } };

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'report-test-'));
  write(join(root, 'evals', 'demo', 'config.json'), '{}');
  saveIteration(root, 1, [run('with_skill', 'claude-sonnet-5-5', ASSERTIONS_WITH), run('without_skill', 'claude-sonnet-5-5', ASSERTIONS_WITHOUT), run('with_skill', 'claude-opus-5-5', ASSERTIONS_WITH.map((a) => (a.index === 1 ? A(1, 'PASS') : a)), { id: 2 }), run('without_skill', 'claude-opus-5-5', ASSERTIONS_WITHOUT, { id: 2, cost: 0.1, tokens: 1000 })]);
  saveIteration(root, 2, [run('with_skill', 'claude-sonnet-5-5', ASSERTIONS_WITH), run('without_skill', 'claude-sonnet-5-5', ASSERTIONS_WITHOUT)], { triggers: TRIGGERS, generatedAt: '2026-10-15T08:00:00.000Z' });
  return root;
}

test('report: writes one short eval_results.md per skill with the table, guards apart, routing, cost, failing list and open items', () => {
  const root = repo();
  const io = { out: capture(), err: capture() };
  assert.equal(main(['--family', 'demo', '--iterations', '1,2'], root, io), 0, io.err.text);
  assert.equal(io.out.text.trim(), 'evals/demo/hello/eval_results.md');
  const md = readFileSync(join(root, 'evals', 'demo', 'hello', 'eval_results.md'), 'utf8');
  assert.ok(md.split('\n').length <= 40);
  assert.match(md, /^# hello eval results\n\nGenerated 2026-10-15\. Models: opus-5-5, sonnet-5-5\. Trials: 2 per model\./);
  // sonnet, 2 trials, scored (non-guard, non-manual): with skill 1 PASS + 1 FAIL + 1 PARTIAL per trial = 2/6; baseline 0/6.
  assert.match(md, /\| sonnet-5-5 \| 2 \| 2\/6 \(33\.3%\), 2 partial \| 0\/6 \(0\.0%\) \| \+33\.3 pts \|/);
  // opus, 1 trial: with skill 2 PASS + 1 PARTIAL = 2/3, baseline 0/3.
  assert.match(md, /\| opus-5-5 \| 1 \| 2\/3 \(66\.7%\), 1 partial \| 0\/3 \(0\.0%\) \| \+66\.7 pts \|/);
  assert.match(md, /Guards .* opus-5-5 1\/1 with skill, 1\/1 baseline; sonnet-5-5 2\/2 with skill, 2\/2 baseline\./);
  assert.match(md, /Routing \(sonnet-5-5, 3 runs\/query, iteration 2\): 3\/4 correct \(75\.0%\); misses: q2 \(should trigger, rate 0\.3333\); flaky: q3; confused with: other 1\./);
  assert.match(md, /Cost per run \(average\): opus-5-5 \$0\.20\/2k tokens with skill, \$0\.10\/1k baseline, delta \+\$0\.10; sonnet-5-5 \$0\.20\/2k tokens with skill, \$0\.20\/2k baseline, delta \+\$0\.00\./);
  assert.match(md, /- e1\/a1: regex miss \[2 fail of 2\] - final response did not match \/x\//);
  assert.match(md, /- e1\/a2: assertion 2 \[2 partial of 2\]/);
  assert.match(md, /- e2\/a2: assertion 2 \[1 partial of 1\]/);
  assert.doesNotMatch(md, /a0|a3/);
  assert.match(md, /- 2 manual assertion\(s\) not listed\./);
  assert.match(md, /## Open items\n- _To fill in/);
});

test('report: --triggers picks the trigger iteration; without trigger results routing says so; PASS-only runs list nothing', () => {
  const root = repo();
  const io = { out: capture(), err: capture() };
  assert.equal(main(['--family', 'demo', '--iterations', '1', '--triggers', '2'], root, io), 0, io.err.text);
  const withTriggers = readFileSync(join(root, 'evals', 'demo', 'hello', 'eval_results.md'), 'utf8');
  assert.match(withTriggers, /Routing \(sonnet-5-5, 3 runs\/query, iteration 2\)/);
  const clean = mkdtempSync(join(tmpdir(), 'report-test-'));
  write(join(clean, 'evals', 'demo', 'config.json'), '{}');
  saveIteration(clean, 1, [run('with_skill', 'claude-sonnet-5-5', [A(0, 'PASS')])]);
  assert.equal(main(['--family', 'demo', '--iterations', '1'], clean, { out: capture(), err: capture() }), 0);
  const md = readFileSync(join(clean, 'evals', 'demo', 'hello', 'eval_results.md'), 'utf8');
  assert.match(md, /Routing: not measured/);
  assert.match(md, /\| sonnet-5-5 \| 1 \| 1\/1 \(100\.0%\) \| n\/a \| n\/a \|/);
  assert.match(md, /- None: every graded with-skill assertion passed/);
});

test('report: the failing list is capped so a skill stays within 40 lines', () => {
  const many = Array.from({ length: 30 }, (_, i) => A(i, 'FAIL', { evidence: [{ pass: false, evidence: 'e'.repeat(500) }], text: 't'.repeat(300) }));
  const md = renderSkill({ skill: 'hello', runs: [run('with_skill', 'claude-sonnet-5-5', many), run('without_skill', 'claude-sonnet-5-5', many)], triggers: null, iterations: [1], date: '2026-10-15', rootDir: '/x' });
  assert.ok(md.split('\n').length <= 40, `${md.split('\n').length} lines`);
  assert.match(md, /- \.\.\. and 15 more/);
  assert.ok(md.split('\n').every((l) => l.length < 400));
});

test('report: usage errors exit 2 and write nothing; --help exits 0', () => {
  const root = repo();
  for (const argv of [[], ['--family', 'demo'], ['--family', 'ghost', '--iterations', '1'], ['--family', 'demo', '--iterations', 'x'], ['--family', 'demo', '--iterations', '9'], ['--family', 'demo', '--iterations', '1', '--triggers', '1'], ['--nope']]) {
    const io = { out: capture(), err: capture() };
    assert.equal(main(argv, root, io), 2, argv.join(' '));
    assert.match(io.err.text, /^report: /);
  }
  assert.equal(existsSync(join(root, 'evals', 'demo', 'hello', 'eval_results.md')), false);
  const io = { out: capture(), err: capture() };
  assert.equal(main(['-h'], root, io), 0);
  assert.match(io.out.text, /Usage:/);
});
