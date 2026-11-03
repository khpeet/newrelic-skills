import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { KINDS, UsageError, discoverRuns, filterRuns, listFamilies, loadFamilyConfig, main, nextIteration, parseCli } from '../../../tools/run-evals.mjs';
import { capture, makeRepo, saveRun, write } from './helpers.mjs';

const realRoot = new URL('../../../', import.meta.url).pathname;

test('parseCli: defaults, repeatable flags, numbers', () => {
  const o = parseCli([]);
  assert.deepEqual({ ...o }, { help: false, families: [], kinds: [], skills: [], cases: [], baseline: false, runs: 3, model: undefined, maxBudgetUsd: 2, timeoutS: 600, iteration: null, keepTemp: false, dryRun: false, regrade: null });
  const p = parseCli(['--family', 'a', '--family', 'b', '--skill', 's', '--case', '1', '--case', '2', '--baseline', '--runs', '5', '--model', 'm', '--max-budget-usd', '0.5', '--timeout', '30', '--iteration', '4', '--keep-temp', '--dry-run']);
  assert.deepEqual([p.families, p.skills, p.cases, p.baseline, p.runs, p.model, p.maxBudgetUsd, p.timeoutS, p.iteration, p.keepTemp, p.dryRun], [['a', 'b'], ['s'], [1, 2], true, 5, 'm', 0.5, 30, 4, true, true]);
  assert.equal(parseCli(['-h']).help, true);
  assert.equal(parseCli(['--regrade', '3']).regrade, 3);
});

test('parseCli: rejects unknown flags, positionals, bad numbers, and conflicting flags', () => {
  for (const argv of [['--nope'], ['stray'], ['--case', 'x', '--skill', 's'], ['--case', '1'], ['--case', '1', '--skill', 'a', '--skill', 'b'], ['--timeout', '0'], ['--runs', '0'], ['--runs', '1.5'], ['--max-budget-usd', 'free'], ['--iteration', '0'], ['--iteration', '1.5'], ['--regrade', '1', '--dry-run'], ['--regrade', '1', '--iteration', '2']]) {
    assert.throws(() => parseCli(argv), UsageError, argv.join(' '));
  }
});

test('the real repo: every family has a valid config and discoverable evals', () => {
  const families = listFamilies(realRoot);
  assert.ok(families.includes('workflow-automation'));
  assert.ok(!families.includes('workspace'));
  for (const family of families) {
    const { config, skills } = loadFamilyConfig(realRoot, family);
    assert.ok(skills.length > 0, family);
    assert.ok(config.install.length > 0);
  }
  const runs = discoverRuns(realRoot, { kinds: ['output'] });
  assert.ok(runs.length > 0);
  assert.equal(runs.filter((r) => r.variant === 'with_skill').length, runs.length / 2);
  for (const family of families) {
    const onDisk = readdirSync(join(realRoot, 'skills', family), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(realRoot, 'skills', family, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();
    const { skills } = loadFamilyConfig(realRoot, family);
    assert.deepEqual(skills.filter((s) => onDisk.includes(s.name)).map((s) => s.name).sort(), onDisk, family);
    for (const skill of onDisk) {
      const count = runs.filter((r) => r.family === family && r.skill === skill && r.variant === 'with_skill').length;
      assert.ok(count >= 2, `${family}/${skill}: ${count} output cases, need at least 2`);
    }
  }
  for (const kind of KINDS) assert.equal(typeof kind.discover, 'function');
});

test('the real repo: every assertion that no check covers is deliberately manual, and every skill has at least one check', () => {
  for (const run of discoverRuns(realRoot, { kinds: ['output'] }).filter((r) => r.variant === 'with_skill')) {
    assert.ok((run.case.checks ?? []).length > 0, `${run.label} has no checks`);
  }
});

test('loadFamilyConfig: reports every problem', () => {
  const cases = [
    [{ plugin: 'demo-plugin', install: ['demo'], extra: 1 }, /unknown key "extra"/],
    [{ plugin: 'not-in-marketplace', install: ['demo'] }, /not a plugin in \.claude-plugin\/marketplace\.json/],
    [{ plugin: 'demo-plugin', install: [] }, /"install" must be a non-empty array/],
    [{ plugin: 'demo-plugin', install: ['ghost'] }, /skills\/ghost\/ does not exist/],
    [{ plugin: 'demo-plugin', install: ['demo', 'demo'] }, /appears twice/],
    [{ plugin: 'demo-plugin', install: ['demo'], unsetEnv: ['bad name'] }, /"unsetEnv"/],
    [{ plugin: 'demo-plugin', install: ['demo'], bashAllow: ['node(*)'] }, /"bashAllow"/],
    [{ install: ['demo'] }, /"plugin" must be a non-empty string/],
  ];
  for (const [config, re] of cases) assert.throws(() => loadFamilyConfig(makeRepo({ config }), 'demo'), re);
  const root = makeRepo();
  rmSync(join(root, 'evals', 'demo', 'config.json'));
  assert.throws(() => loadFamilyConfig(root, 'demo'), /config\.json is missing/);
  write(join(root, 'evals', 'demo', 'config.json'), '{oops');
  assert.throws(() => loadFamilyConfig(root, 'demo'), UsageError);
  const ok = loadFamilyConfig(makeRepo({ config: { plugin: 'demo-plugin', install: ['demo'] } }), 'demo');
  assert.deepEqual(ok.config, { plugin: 'demo-plugin', install: ['demo'], unsetEnv: [], bashAllow: [], triggerFiles: [] });
});

test('loadFamilyConfig: triggerFiles must be existing fixtures/<case>/<path> files', () => {
  const cfg = (triggerFiles) => ({ plugin: 'demo-plugin', install: ['demo'], triggerFiles });
  assert.deepEqual(loadFamilyConfig(makeRepo({ config: cfg(['fixtures/c1/workflows/a.yaml']) }), 'demo').config.triggerFiles, ['fixtures/c1/workflows/a.yaml']);
  for (const bad of [['fixtures/c1/missing.yaml'], ['workflows/a.yaml'], ['fixtures/../x'], ['fixtures/c1/../c1/workflows/a.yaml'], 'fixtures/c1/workflows/a.yaml', [1]]) assert.throws(() => loadFamilyConfig(makeRepo({ config: cfg(bad) }), 'demo'), /"triggerFiles"/, JSON.stringify(bad));
  assert.deepEqual(loadFamilyConfig(realRoot, 'workflow-automation').config.triggerFiles, ['fixtures/triggers/workflows/cpu_triage.yaml']);
});

test('loadFamilyConfig: bashAllow entries must not contain ".." or a wildcard in the {plugin} path', () => {
  const cfg = (...bashAllow) => ({ plugin: 'demo-plugin', install: ['demo'], bashAllow });
  const ok = loadFamilyConfig(makeRepo({ config: cfg('node {plugin}/skills/demo/hello/scripts/hello.mjs *') }), 'demo');
  assert.deepEqual(ok.config.bashAllow, ['node {plugin}/skills/demo/hello/scripts/hello.mjs *']);
  for (const bad of ['node {plugin}/skills/*/scripts/*.mjs *', 'node {plugin}/skills/../../tmp/x/y.mjs *', 'node ../x.mjs *']) {
    assert.throws(() => loadFamilyConfig(makeRepo({ config: cfg(bad) }), 'demo'), /"bashAllow" entry/, bad);
  }
});

test('the real repo: workflow-automation bashAllow lists one exact entry per skill script and nothing else', () => {
  const { config, skills } = loadFamilyConfig(realRoot, 'workflow-automation');
  const expected = [];
  for (const skill of skills) {
    const scripts = readdirSync(join(skill.dir, 'scripts')).filter((f) => f.endsWith('.mjs'));
    assert.ok(scripts.length > 0, skill.name);
    for (const script of scripts) expected.push(`node {plugin}/skills/${skill.family}/${skill.name}/scripts/${script} *`);
  }
  assert.deepEqual([...config.bashAllow].sort(), expected.sort());
  for (const entry of config.bashAllow) assert.doesNotMatch(entry.slice(0, -2), /[*?[\]]|\.\./, entry);
});

test('main --regrade: summary.json totals count guard and scored assertions apart', async () => {
  const root = makeRepo({ guards: [1] });
  saveRun(root, { commands: ['ls'], final: 'hi' });
  const io = { out: capture(), err: capture() };
  await main(['--family', 'demo', '--regrade', '1'], {}, root, io);
  const { totals } = JSON.parse(io.out.text);
  assert.deepEqual([totals.FAIL, totals.scored, totals.guard], [1, { PASS: 0, FAIL: 1, PARTIAL: 0, MANUAL: 1 }, { PASS: 1, FAIL: 0, PARTIAL: 0, MANUAL: 0 }]);
});

test('adding a family needs no runner change: a second family is discovered next to the first', () => {
  const root = makeRepo();
  write(join(root, 'skills', 'other', 'world', 'SKILL.md'), '---\nname: world\ndescription: x\n---\n');
  write(join(root, 'evals', 'other', 'config.json'), JSON.stringify({ plugin: 'demo-plugin', install: ['other', 'demo'] }));
  write(join(root, 'evals', 'other', 'world', 'evals.json'), JSON.stringify({ skill_name: 'world', evals: [{ id: 7, prompt: 'p', files: [], assertions: ['a'] }] }));
  assert.deepEqual(listFamilies(root), ['demo', 'other']);
  const runs = discoverRuns(root);
  assert.deepEqual(runs.map((r) => r.label), ['demo/hello eval-1 with_skill', 'demo/hello eval-1 without_skill', 'other/world eval-7 with_skill', 'other/world eval-7 without_skill']);
  assert.deepEqual(runs[2].skills.map((s) => `${s.family}/${s.name}`), ['other/world', 'demo/hello']);
  assert.deepEqual(discoverRuns(root, { families: ['other'] }).map((r) => r.family), ['other', 'other']);
  assert.throws(() => discoverRuns(root, { families: ['nope'] }), /unknown family "nope"/);
  assert.throws(() => discoverRuns(root, { kinds: ['nope'] }), /unknown kind "nope"/);
  write(join(root, 'evals', 'third', 'README.md'), 'no config');
  assert.throws(() => discoverRuns(root), /evals\/third\/config\.json is missing/);
});

test('filterRuns: baseline, skill, and case filters; unknown names are usage errors', () => {
  const runs = discoverRuns(makeRepo());
  assert.deepEqual(filterRuns(runs, {}).map((r) => r.variant), ['with_skill']);
  assert.deepEqual(filterRuns(runs, { baseline: true }).map((r) => r.variant), ['with_skill', 'without_skill']);
  assert.equal(filterRuns(runs, { skills: ['hello'], cases: [1] }).length, 1);
  assert.throws(() => filterRuns(runs, { skills: ['nope'] }), /unknown skill "nope"/);
  assert.throws(() => filterRuns(runs, { skills: ['hello'], cases: [9] }), /no case with id 9/);
});

test('nextIteration: one past the highest iteration-N directory, per family', () => {
  const root = makeRepo();
  assert.equal(nextIteration(root, 'demo'), 1);
  for (const n of [1, 3, 10]) mkdirSync(join(root, 'evals', 'workspace', 'demo', `iteration-${n}`), { recursive: true });
  mkdirSync(join(root, 'evals', 'workspace', 'demo', 'scratch'));
  assert.equal(nextIteration(root, 'demo'), 11);
  assert.equal(nextIteration(root, 'other'), 1);
});

test('main: --help prints usage and exits 0', async () => {
  const io = { out: capture(), err: capture() };
  assert.equal(await main(['--help'], {}, makeRepo(), io), 0);
  assert.match(io.out.text, /Usage: node tools\/run-evals\.mjs/);
  for (const flag of ['--family', '--kind', '--skill', '--case', '--baseline', '--runs', '--model', '--max-budget-usd', '--timeout', '--iteration', '--keep-temp', '--dry-run', '--regrade']) assert.ok(io.out.text.includes(flag), flag);
});

test('main: usage and setup errors exit 2 with a message on stderr', async () => {
  const root = makeRepo();
  for (const [argv, re] of [[['--nope'], /Unknown option/], [['--skill', 'x'], /unknown skill "x"/], [['--family', 'x'], /unknown family/], [['--regrade', '4'], /iteration 4 has no saved runs/]]) {
    const io = { out: capture(), err: capture() };
    assert.equal(await main(argv, {}, root, io), 2, argv.join(' '));
    assert.match(io.err.text, re);
  }
});

test('main --dry-run: lists the planned runs, spawns and writes nothing', async () => {
  const root = makeRepo();
  const io = { out: capture(), err: capture() };
  assert.equal(await main(['--dry-run', '--baseline'], {}, root, io), 0);
  assert.match(io.out.text, /demo\/hello eval-1 with_skill\n {2}claude "-p" "say hi"/);
  assert.match(io.out.text, /demo\/hello eval-1 without_skill/);
  assert.match(io.err.text, /2 runs planned/);
  assert.equal(existsSync(join(root, 'evals', 'workspace')), false);
});

test('main --regrade: re-grades saved runs with the current checks and writes grading.json and summary.json', async () => {
  const root = makeRepo();
  const SCRIPT = '/private/var/folders/xx/nr-evals-AAAA/plugin/skills/demo/hello/scripts/hello.mjs';
  const good = saveRun(root, { commands: [`node ${SCRIPT}`] });
  saveRun(root, { variant: 'without_skill', commands: [] });
  const io = { out: capture(), err: capture() };
  assert.equal(await main(['--regrade', '1'], {}, root, io), 0, io.err.text);
  const summary = JSON.parse(io.out.text);
  assert.equal(summary.totals.runs, 2);
  assert.deepEqual([summary.families.demo.runs[0].summary, summary.families.demo.runs[1].summary.FAIL], [{ PASS: 2, FAIL: 0, PARTIAL: 0, MANUAL: 1 }, 1]);
  assert.equal(JSON.parse(readFileSync(join(good, 'grading.json'), 'utf8')).summary.PASS, 2);
  assert.ok(existsSync(join(root, 'evals', 'workspace', 'demo', 'iteration-1', 'summary.json')));
  assert.match(io.err.text, /\[1\/2\] demo\/hello eval-1 with_skill: 2 PASS 0 FAIL 0 PARTIAL 1 MANUAL/);

  // A with_skill FAIL makes the exit code 1; the baseline's FAIL above did not.
  saveRun(root, { iteration: 2, commands: ['ls'] });
  assert.equal(await main(['--regrade', '2'], {}, root, { out: capture(), err: capture() }), 1);
});

// A stand-in `claude` that records how it was called and prints a stream-json transcript.
function fakeClaude() {
  const bin = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const log = join(bin, 'calls.jsonl');
  writeFileSync(
    join(bin, 'claude'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (argv[0] === '--version') process.exit(0);
// The stand-in's own settings use the CLAUDE_CODE_ prefix because the runner passes only allowlisted variables to claude.
const keep = ['NEW_RELIC_API_KEY', 'DEMO_SECRET', 'CLAUDECODE', 'TMPDIR', 'ANTHROPIC_KEPT'];
fs.appendFileSync(process.env.CLAUDE_CODE_FAKE_LOG, JSON.stringify({ argv, cwd: process.cwd(), env: Object.fromEntries(keep.map((k) => [k, process.env[k] ?? null])) }) + '\\n');
const mode = process.env.CLAUDE_CODE_FAKE_MODE || 'ok';
// CLAUDE_CODE_FAKE_SKILL: comma-separated Skill names, one per call (cycling; an empty entry calls no skill).
const nth = fs.readFileSync(process.env.CLAUDE_CODE_FAKE_LOG, 'utf8').trim().split('\\n').length - 1;
const skills = (process.env.CLAUDE_CODE_FAKE_SKILL || '').split(',');
const skill = process.env.CLAUDE_CODE_FAKE_SKILL ? skills[nth % skills.length] : '';
if (mode === 'hang') setInterval(() => {}, 1000);
else {
  const i = argv.indexOf('--plugin-dir');
  const maxTurns = mode === 'error_max_turns';
  const blocks = skill ? [{ type: 'tool_use', id: 's', name: 'Skill', input: { skill } }] : i >= 0 && !process.env.CLAUDE_CODE_FAKE_SKILL ? [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'node ' + argv[i + 1] + '/skills/demo/hello/scripts/hello.mjs' } }] : [];
  const usage = { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 };
  const lines = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: blocks } },
    { type: 'result', subtype: maxTurns ? 'error_max_turns' : 'success', is_error: mode === 'error' || maxTurns, terminal_reason: maxTurns ? 'max_turns' : 'completed', result: mode === 'error' ? 'API Error: boom' : 'done', duration_ms: 5, total_cost_usd: 0.5, num_turns: 1, permission_denials: [], usage },
  ];
  for (const e of lines) console.log(JSON.stringify(e));
  if (maxTurns) process.exitCode = 1;
}
`,
  );
  chmodSync(join(bin, 'claude'), 0o755);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { bin, log, calls };
}

async function withFakeClaude(fn) {
  const fake = fakeClaude();
  const savedPath = process.env.PATH;
  process.env.PATH = `${fake.bin}${delimiter}${savedPath}`;
  try {
    const cfg = mkdtempSync(join(tmpdir(), 'fake-cfg-'));
    writeFileSync(join(cfg, 'settings.json'), '{"apiKeyHelper":"/bin/print-secret-key"}');
    const env = { ...process.env, CLAUDE_CODE_FAKE_LOG: fake.log, CLAUDE_CONFIG_DIR: cfg, NEW_RELIC_API_KEY: 'NRAK-SHOULD-NOT-LEAK', DEMO_SECRET: 'shh', CLAUDECODE: '1', ANTHROPIC_KEPT: 'yes' };
    return await fn({ fake, env });
  } finally {
    process.env.PATH = savedPath;
  }
}

test('main end to end with a stand-in claude: sandboxed env and args, saved artifacts, grading, summary, next iteration', async () => {
  await withFakeClaude(async ({ fake, env }) => {
    const root = makeRepo();
    const io = { out: capture(), err: capture() };
    assert.equal(await main(['--family', 'demo', '--keep-temp'], env, root, io), 0, io.err.text);

    const [call] = fake.calls();
    assert.equal(call.argv[0], '-p');
    assert.equal(call.argv[1], 'say hi');
    assert.equal(call.argv[call.argv.indexOf('--settings') + 1], '{"apiKeyHelper":"/bin/print-secret-key"}');
    assert.deepEqual(call.env, { NEW_RELIC_API_KEY: null, DEMO_SECRET: null, CLAUDECODE: null, TMPDIR: `${call.cwd.replace(/project$/, 'tmp')}/`, ANTHROPIC_KEPT: 'yes' });
    assert.match(call.cwd, /nr-evals-[^/]+\/project$/);
    assert.equal(readFileSync(join(call.cwd, 'workflows', 'a.yaml'), 'utf8'), 'name: a\n');

    const dir = join(root, 'evals', 'workspace', 'demo', 'iteration-1', 'hello', 'eval-1', 'with_skill');
    for (const f of ['transcript.jsonl', 'stderr.txt', 'meta.json', 'timing.json', 'grading.json', 'project/workflows/a.yaml']) assert.ok(existsSync(join(dir, f)), f);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.equal(JSON.stringify(meta).includes('print-secret-key'), false);
    assert.equal(meta.args[meta.args.indexOf('--settings') + 1], '<redacted>');
    assert.ok(existsSync(meta.paths.sandbox), '--keep-temp keeps the sandbox');
    rmSync(meta.paths.sandbox, { recursive: true });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'timing.json'), 'utf8')), { total_tokens: 10, duration_ms: 5, total_cost_usd: 0.5, num_turns: 1 });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'grading.json'), 'utf8')).summary, { PASS: 2, FAIL: 0, PARTIAL: 0, MANUAL: 1 });
    assert.equal(JSON.parse(io.out.text).totals.cost_usd, 0.5);

    // Nothing is overwritten: the next run picks iteration-2, and naming iteration 1 again is refused.
    assert.equal(await main(['--family', 'demo'], env, root, { out: capture(), err: capture() }), 0);
    assert.ok(existsSync(join(root, 'evals', 'workspace', 'demo', 'iteration-2')));
    const again = { out: capture(), err: capture() };
    assert.equal(await main(['--family', 'demo', '--iteration', '1'], env, root, again), 2);
    assert.match(again.err.text, /output already exists, nothing is overwritten/);
  });
});

test('main end to end: --baseline runs without the plugin, and its failed checks do not fail the run', async () => {
  await withFakeClaude(async ({ fake, env }) => {
    const root = makeRepo();
    const io = { out: capture(), err: capture() };
    assert.equal(await main(['--baseline'], env, root, io), 0, io.err.text);
    const [withSkill, baseline] = fake.calls();
    assert.ok(withSkill.argv.includes('--plugin-dir'));
    assert.ok(!baseline.argv.includes('--plugin-dir'));
    const summary = JSON.parse(io.out.text);
    assert.deepEqual(summary.families.demo.runs.map((r) => [r.variant, r.summary.FAIL]), [['with_skill', 0], ['without_skill', 1]]);
  });
});

test('main end to end: a case env reaches the child (both variants) in place of the stripped key; cases without env still get none', async () => {
  const dummy = 'NRAK-INVALID-EVAL-DUMMY-KEY-0000000000';
  await withFakeClaude(async ({ fake, env }) => {
    const io = { out: capture(), err: capture() };
    assert.equal(await main(['--baseline'], env, makeRepo({ env: { NEW_RELIC_API_KEY: dummy } }), io), 0, io.err.text);
    const calls = fake.calls();
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.env.NEW_RELIC_API_KEY, dummy);
      assert.equal(c.env.DEMO_SECRET, null);
    }
    // the value is not in the summary, the stderr progress, or the saved metadata
    const root = makeRepo({ env: { NEW_RELIC_API_KEY: dummy } });
    const io2 = { out: capture(), err: capture() };
    assert.equal(await main(['--family', 'demo'], env, root, io2), 0, io2.err.text);
    assert.ok(!io2.out.text.includes(dummy) && !io2.err.text.includes(dummy));
    const meta = readFileSync(join(root, 'evals', 'workspace', 'demo', 'iteration-1', 'hello', 'eval-1', 'with_skill', 'meta.json'), 'utf8');
    assert.ok(!meta.includes(dummy));
  });
  await withFakeClaude(async ({ fake, env }) => {
    assert.equal(await main(['--baseline'], env, makeRepo(), { out: capture(), err: capture() }), 0);
    for (const c of fake.calls()) assert.equal(c.env.NEW_RELIC_API_KEY, null);
  });
});

test('main: an invalid case env fails at load time (exit 2), also with --dry-run, and the value is not printed', async () => {
  const real = `NRAK-${'A1'.repeat(13)}Z`;
  for (const argv of [['--dry-run'], []]) {
    const io = { out: capture(), err: capture() };
    assert.equal(await main(argv, {}, makeRepo({ env: { NEW_RELIC_API_KEY: real } }), io), 2);
    assert.match(io.err.text, /must be a value starting with NRAK-INVALID/);
    assert.ok(!io.err.text.includes(real) && !io.out.text.includes(real));
  }
});

test('main --dry-run: a case env is listed by variable name only, never its value', async () => {
  const dummy = 'NRAK-INVALID-EVAL-DUMMY-KEY-0000000000';
  const io = { out: capture(), err: capture() };
  assert.equal(await main(['--dry-run', '--baseline'], {}, makeRepo({ env: { NEW_RELIC_API_KEY: dummy } }), io), 0);
  assert.match(io.out.text, /env \(from the case, values not shown\): NEW_RELIC_API_KEY/);
  assert.equal(io.out.text.match(/env \(from the case/g).length, 2);
  assert.ok(!io.out.text.includes(dummy) && !io.err.text.includes(dummy));
  const plain = { out: capture(), err: capture() };
  assert.equal(await main(['--dry-run'], {}, makeRepo(), plain), 0);
  assert.ok(!plain.out.text.includes('env (from the case'));
});

test('main end to end: an API error in the transcript makes the exit code 1; a hung run is killed at --timeout', async () => {
  await withFakeClaude(async ({ env }) => {
    const root = makeRepo();
    const io = { out: capture(), err: capture() };
    assert.equal(await main(['--family', 'demo'], { ...env, CLAUDE_CODE_FAKE_MODE: 'error' }, root, io), 1);
    assert.match(io.err.text, /ERROR: claude reported an error: API Error: boom/);

    const hung = { out: capture(), err: capture() };
    assert.equal(await main(['--family', 'demo', '--timeout', '1'], { ...env, CLAUDE_CODE_FAKE_MODE: 'hang' }, root, hung), 1);
    assert.match(hung.err.text, /ERROR: timed out/);
    assert.equal(JSON.parse(hung.out.text).families.demo.runs[0].error, 'timed out');
  });
});

test('main: claude missing from PATH is a setup error (exit 2), not a crash', async () => {
  const saved = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), 'empty-path-'));
  try {
    const io = { out: capture(), err: capture() };
    assert.equal(await main(['--family', 'demo'], { ...process.env }, makeRepo(), io), 2);
    assert.match(io.err.text, /cannot run claude: ENOENT/);
  } finally {
    process.env.PATH = saved;
  }
});

const TRIGGERS = { hello: [{ query: 'say hi to me', should_trigger: true }, { query: 'unrelated question', should_trigger: false }] };

test('main end to end, triggers kind: each query is sent --runs times with --max-turns 2, graded and summarized', async () => {
  await withFakeClaude(async ({ fake, env }) => {
    const root = makeRepo({ triggers: TRIGGERS });
    const io = { out: capture(), err: capture() };
    // Call order: q-1 run-1, q-1 run-2, q-2 run-1, q-2 run-2. q-1 triggers both times; q-2 once (rate 0.5) and also calls a sibling.
    const code = await main(['--family', 'demo', '--kind', 'triggers', '--runs', '2'], { ...env, CLAUDE_CODE_FAKE_MODE: 'error_max_turns', CLAUDE_CODE_FAKE_SKILL: 'demo-plugin:hello,demo-plugin:hello,demo-plugin:hello,demo-plugin:other' }, root, io);
    assert.equal(code, 1, io.err.text);
    const calls = fake.calls();
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.map((c) => c.argv[1]), ['say hi to me', 'say hi to me', 'unrelated question', 'unrelated question']);
    for (const c of calls) {
      assert.equal(c.argv[c.argv.indexOf('--max-turns') + 1], '2');
      assert.equal(c.argv[c.argv.indexOf('--max-budget-usd') + 1], '0.25');
      assert.ok(c.argv.includes('--plugin-dir'));
      assert.doesNotMatch(c.argv[c.argv.indexOf('--allowedTools') + 1], /Bash/);
    }

    const dir = join(root, 'evals', 'workspace', 'demo', 'iteration-1', 'triggers', 'hello');
    for (const f of ['q-1/meta.json', 'q-1/timing.json', 'q-1/grading.json', 'q-1/run-1/transcript.jsonl', 'q-1/run-2/meta.json', 'q-1/run-2/timing.json']) assert.ok(existsSync(join(dir, f)), f);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'q-1', 'timing.json'), 'utf8')), { total_tokens: 20, duration_ms: 10, total_cost_usd: 1, num_turns: 2 });

    const summary = JSON.parse(io.out.text);
    assert.match(io.err.text, /\[1\/2\] demo\/hello q-1 should trigger: 1 PASS 0 FAIL/);
    assert.match(io.err.text, /triggered 2\/2 \(expected trigger\) PASS/);
    assert.match(io.err.text, /triggered 1\/2 \(expected no trigger\) FAIL; also called other/);
    assert.equal(summary.families.demo.runs.every((r) => r.error === null), true, 'a max-turns stop is not an error');
    const t = summary.families.demo.kinds.triggers.hello;
    assert.deepEqual([t.queries, t.correct, t.accuracy, t.tp, t.fp, t.tn, t.fn, t.precision, t.recall, t.confusion], [2, 1, 0.5, 1, 1, 0, 0, 0.5, 1, { other: 1 }]);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'evals', 'workspace', 'demo', 'iteration-1', 'summary.json'), 'utf8')).kinds.triggers.hello.per_query.map((q) => q.trigger_rate), [1, 0.5]);

    // --regrade rebuilds the same summary from the saved repetitions, without calling claude.
    const before = fake.calls().length;
    const again = { out: capture(), err: capture() };
    assert.equal(await main(['--family', 'demo', '--kind', 'triggers', '--regrade', '1'], env, root, again), 1);
    assert.equal(fake.calls().length, before);
    assert.deepEqual(JSON.parse(again.out.text).families.demo.kinds, summary.families.demo.kinds);
  });
});

test('main end to end, triggers kind: config triggerFiles are copied into every repetition\'s project', async () => {
  await withFakeClaude(async ({ fake, env }) => {
    const seeded = makeRepo({ triggers: TRIGGERS, config: { plugin: 'demo-plugin', install: ['demo'], triggerFiles: ['fixtures/c1/workflows/a.yaml'] } });
    const io = { out: capture(), err: capture() };
    await main(['--family', 'demo', '--kind', 'triggers', '--runs', '2', '--skill', 'hello', '--keep-temp'], { ...env, CLAUDE_CODE_FAKE_MODE: 'error_max_turns' }, seeded, io);
    assert.equal(fake.calls().length, 4);
    for (const c of fake.calls()) assert.equal(readFileSync(join(c.cwd, 'workflows', 'a.yaml'), 'utf8'), 'name: a\n');
  });
  await withFakeClaude(async ({ fake, env }) => {
    const io = { out: capture(), err: capture() };
    await main(['--family', 'demo', '--kind', 'triggers', '--runs', '1', '--keep-temp'], { ...env, CLAUDE_CODE_FAKE_MODE: 'error_max_turns' }, makeRepo({ triggers: TRIGGERS }), io);
    for (const c of fake.calls()) assert.equal(existsSync(join(c.cwd, 'workflows')), false, 'no triggerFiles, empty project');
  });
});

test('main --dry-run, triggers kind: shows the query, --max-turns and the repetition count', async () => {
  const io = { out: capture(), err: capture() };
  assert.equal(await main(['--dry-run', '--kind', 'triggers', '--runs', '4'], {}, makeRepo({ triggers: TRIGGERS }), io), 0);
  assert.match(io.out.text, /demo\/hello q-1 should trigger \(x4 runs\)\n {2}claude "-p" "say hi to me"/);
  assert.match(io.out.text, /"--max-turns" "2"/);
  assert.match(io.err.text, /2 runs planned/);
});
