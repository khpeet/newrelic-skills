import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECKS, expandPattern, gradeAssertions, resolveYamlPath, validateChecks, validateGuards } from '../../../tools/evals/checks.mjs';
import { write } from './helpers.mjs';

const PROJECT = '/private/var/folders/x.y/nr-evals-A1/project';
const PLUGIN = '/private/var/folders/x.y/nr-evals-A1/plugin';

// A run directory whose project/ holds `files`; `fixtures` maps project paths to their original bytes.
function ctxWith({ files = {}, fixtures = {}, commands = [], final = '', variant = 'with_skill', pluginNewFiles = [], pluginChangedFiles = [] } = {}) {
  const runDir = mkdtempSync(join(tmpdir(), 'checks-run-'));
  for (const [rel, text] of Object.entries(files)) write(join(runDir, 'project', rel), text);
  return {
    runDir, projectDir: PROJECT, pluginDir: PLUGIN, skillRel: { build: 'skills/demo/build', run: 'skills/demo/run' }, variant, commands, final, pluginNewFiles, pluginChangedFiles,
    fixtureFor: (rel) => (rel in fixtures ? Buffer.from(fixtures[rel]) : null),
  };
}
const run = (check, ctx) => CHECKS[check.type].run(check, ctx);

test('expandPattern: regex-escapes paths, makes /private optional, expands only the three tokens', () => {
  const ctx = ctxWith();
  const out = expandPattern('cd {projectDir} && node {skillDir:build}/x \\{\\{ a{2}', ctx);
  assert.match(out, /^cd \(\?:\/private\)\?\/var\/folders\/x\\\.y\/nr-evals-A1\/project && node/);
  assert.ok(out.endsWith('/skills/demo/build/x \\{\\{ a{2}'));
  assert.ok(new RegExp(expandPattern('{projectDir}', ctx)).test('/var/folders/x.y/nr-evals-A1/project'));
  assert.ok(new RegExp(expandPattern('{projectDir}', ctx)).test(PROJECT));
  assert.ok(!new RegExp(expandPattern('{projectDir}', ctx)).test('/var/folders/xzy/nr-evals-A1/project'));
  assert.throws(() => expandPattern('{skillDir:nope}', ctx), /unknown skill/);
});

test('resolveYamlPath: indexes arrays, fans out with *, returns [] for missing paths', () => {
  const doc = { steps: [{ name: 'a', inputs: { logs: [{ message: 'x' }, { message: 'y' }] } }, { name: 'b' }], map: { k1: { v: 1 }, k2: { v: 2 } } };
  assert.deepEqual(resolveYamlPath(doc, 'steps.0.name'), ['a']);
  assert.deepEqual(resolveYamlPath(doc, 'steps.*.name'), ['a', 'b']);
  assert.deepEqual(resolveYamlPath(doc, 'steps.0.inputs.logs.*.message'), ['x', 'y']);
  assert.deepEqual(resolveYamlPath(doc, 'map.*.v'), [1, 2]);
  assert.deepEqual(resolveYamlPath(doc, 'steps.5.name'), []);
  assert.deepEqual(resolveYamlPath(doc, 'steps.name'), []);
  assert.deepEqual(resolveYamlPath(doc, 'nope.deeper'), []);
});

test('command checks: cmd_matches, no_cmd_matches, cmd_before, first_cmd_excludes', () => {
  const ctx = ctxWith({ commands: ['node a.mjs describe x', 'node a.mjs write --file d', 'node a.mjs write --file d --force'] });
  assert.equal(run({ type: 'cmd_matches', pattern: 'describe' }, ctx).pass, true);
  assert.equal(run({ type: 'cmd_matches', pattern: 'DESCRIBE' }, ctx).pass, false);
  assert.equal(run({ type: 'cmd_matches', pattern: 'DESCRIBE', flags: 'i' }, ctx).pass, true);
  assert.equal(run({ type: 'no_cmd_matches', pattern: 'publish' }, ctx).pass, true);
  assert.match(run({ type: 'no_cmd_matches', pattern: '--force' }, ctx).evidence, /--force/);
  assert.equal(run({ type: 'cmd_before', first: 'describe', then: '\\bwrite\\b' }, ctx).pass, true);
  assert.equal(run({ type: 'cmd_before', first: '\\bwrite\\b', then: 'describe' }, ctx).pass, false);
  assert.match(run({ type: 'cmd_before', first: 'missing', then: 'write' }, ctx).evidence, /no command matched \/missing\//);
  assert.equal(run({ type: 'cmd_before', first: 'describe', then: 'missing' }, ctx).pass, false);
  assert.equal(run({ type: 'first_cmd_excludes', match: '\\bwrite\\b', pattern: '--force' }, ctx).pass, true);
  assert.equal(run({ type: 'first_cmd_excludes', match: '--force', pattern: '--force' }, ctx).pass, false);
  assert.match(run({ type: 'first_cmd_excludes', match: 'nothing', pattern: 'x' }, ctx).evidence, /no command matched/);
});

test('the cd-into-project pattern from evals.json: allows cd into the project, flags any other cd', () => {
  const cd = { type: 'no_cmd_matches', pattern: "\\bcd\\s+(?!['\"]?{projectDir}(?:['\"\\s;&|]|$))" };
  assert.equal(run(cd, ctxWith({ commands: [`cd ${PROJECT} && node x.mjs`, `cd "${PROJECT}"; ls`, `cd /var/folders/x.y/nr-evals-A1/project`] })).pass, true);
  assert.equal(run(cd, ctxWith({ commands: [`cd ${PLUGIN}/skills/demo/build && node x.mjs`] })).pass, false);
  assert.equal(run(cd, ctxWith({ commands: ['cd /tmp'] })).pass, false);
  assert.equal(run(cd, ctxWith({ commands: ['abcd /tmp'] })).pass, true);
});

test('final-response checks', () => {
  const ctx = ctxWith({ final: 'Export NEW_RELIC_API_KEY yourself. Use ${{ :secrets:TOKEN }}.' });
  assert.equal(run({ type: 'final_includes', text: 'NEW_RELIC_API_KEY' }, ctx).pass, true);
  assert.equal(run({ type: 'final_includes', text: 'nope' }, ctx).pass, false);
  assert.equal(run({ type: 'final_excludes', text: 'nope' }, ctx).pass, true);
  assert.equal(run({ type: 'final_excludes', text: 'TOKEN' }, ctx).pass, false);
  assert.equal(run({ type: 'final_matches', pattern: '\\$\\{\\{\\s*:secrets:' }, ctx).pass, true);
  assert.equal(run({ type: 'final_matches', pattern: 'zzz' }, ctx).pass, false);
});

test('file checks: exists, absent, excludes, unchanged, project_excludes', () => {
  const ctx = ctxWith({ files: { 'workflows/a.yaml': 'name: a\n', 'workflows/b.yaml': 'name: b\n# SECRET-1\n', 'notes/n.txt': 'hello' }, fixtures: { 'workflows/a.yaml': 'name: a\n', 'workflows/b.yaml': 'name: b\n' } });
  assert.equal(run({ type: 'file_exists', path: 'workflows/a.yaml' }, ctx).pass, true);
  assert.equal(run({ type: 'file_exists', path: 'workflows/zz.yaml' }, ctx).pass, false);
  assert.equal(run({ type: 'file_absent', path: 'workflows/zz.yaml' }, ctx).pass, true);
  assert.equal(run({ type: 'file_absent', path: 'workflows' }, ctx).pass, false);
  assert.equal(run({ type: 'file_excludes', path: 'workflows/a.yaml', text: ':secrets:' }, ctx).pass, true);
  assert.equal(run({ type: 'file_excludes', path: 'workflows/b.yaml', text: 'SECRET-1' }, ctx).pass, false);
  assert.match(run({ type: 'file_excludes', path: 'workflows/zz.yaml', text: 'x' }, ctx).evidence, /does not exist/);
  assert.equal(run({ type: 'file_unchanged', path: 'workflows/a.yaml' }, ctx).pass, true);
  assert.match(run({ type: 'file_unchanged', path: 'workflows/b.yaml' }, ctx).evidence, /differs/);
  assert.match(run({ type: 'file_unchanged', path: 'notes/n.txt' }, ctx).evidence, /no fixture/);
  assert.equal(run({ type: 'file_unchanged', path: 'workflows/gone.yaml' }, { ...ctx, fixtureFor: () => Buffer.from('x') }).evidence, 'workflows/gone.yaml was deleted');
  assert.equal(run({ type: 'project_excludes', text: 'SECRET-1' }, ctx).pass, false);
  assert.match(run({ type: 'project_excludes', text: 'SECRET-1' }, ctx).evidence, /workflows\/b\.yaml/);
  assert.equal(run({ type: 'project_excludes', text: 'SECRET-2' }, ctx).pass, true);
});

test('skill_no_new_files: only files under that skill count; baseline passes', () => {
  const clean = ctxWith({ pluginNewFiles: ['skills/demo/run/out.txt'] });
  assert.equal(run({ type: 'skill_no_new_files', skill: 'build' }, clean).pass, true);
  assert.equal(run({ type: 'skill_no_new_files', skill: 'run' }, clean).pass, false);
  assert.equal(run({ type: 'skill_no_new_files', skill: 'build' }, ctxWith({ pluginChangedFiles: ['skills/demo/build/SKILL.md'] })).pass, false);
  assert.equal(run({ type: 'skill_no_new_files', skill: 'run' }, ctxWith({ variant: 'without_skill', pluginNewFiles: ['skills/demo/run/x'] })).evidence, 'no plugin installed');
});

const WF = 'name: wf\ndescription: d\nworkflowInputs:\n  appName:\n    type: String\nsteps:\n  - name: q\n    type: action\n    action: newrelic.nrdb.query\n    version: 1\n    inputs:\n      query: "FROM X SELECT count(*) SINCE 1 hour ago"\n      selectors:\n        - name: n\n          expression: .results\n  - name: l\n    type: action\n    action: newrelic.ingest.sendLogs\n    version: 1\n    inputs:\n      headers:\n        Pw: "${{ :secrets:PW }}"\n';

test('yaml check: equals, matches, length, minLength, keys, wildcard "any" semantics, and failures', () => {
  const ctx = ctxWith({ files: { 'workflows/wf.yaml': WF, 'workflows/bad.yaml': 'a: [1' } });
  const y = (extra) => run({ type: 'yaml', path: 'workflows/wf.yaml', ...extra }, ctx);
  assert.equal(y({ at: 'name', equals: 'wf' }).pass, true);
  assert.equal(y({ at: 'name', equals: 'other' }).pass, false);
  assert.equal(y({ at: 'steps.0.version', equals: 1 }).pass, true);
  assert.equal(y({ at: 'steps.0.version', matches: '^1$' }).pass, true);
  assert.equal(y({ at: 'steps.0.inputs.query', matches: 'since 1 hour', flags: 'i' }).pass, true);
  assert.equal(y({ at: 'steps.0.inputs.query', matches: 'since 1 hour' }).pass, false);
  assert.equal(y({ at: 'steps', length: 2 }).pass, true);
  assert.equal(y({ at: 'steps', length: 3 }).pass, false);
  assert.equal(y({ at: 'steps.0.inputs.selectors', minLength: 1 }).pass, true);
  assert.equal(y({ at: 'steps.0.inputs.selectors', minLength: 2 }).pass, false);
  assert.equal(y({ at: 'workflowInputs', keys: ['appName'] }).pass, true);
  assert.equal(y({ at: 'workflowInputs', keys: ['appName', 'other'] }).pass, false);
  assert.equal(y({ at: 'steps.*.action', equals: 'newrelic.ingest.sendLogs' }).pass, true);
  assert.equal(y({ at: 'steps.*.inputs.headers.Pw', matches: '^\\$\\{\\{\\s*:secrets:[^}]+\\}\\}$' }).pass, true);
  assert.match(y({ at: 'steps.9.name', equals: 'x' }).evidence, /not found/);
  assert.match(run({ type: 'yaml', path: 'workflows/none.yaml', at: 'name', equals: 'x' }, ctx).evidence, /does not exist/);
  assert.match(run({ type: 'yaml', path: 'workflows/bad.yaml', at: 'a', equals: 1 }, ctx).evidence, /does not parse/);
});

test('changed_yaml_equals: only new or changed files are held to the value', () => {
  const fixtures = { 'workflows/cpu.yaml': 'name: cpu\n' };
  const same = ctxWith({ files: { 'workflows/cpu.yaml': 'name: cpu\n' }, fixtures });
  assert.match(run({ type: 'changed_yaml_equals', dir: 'workflows', at: 'name', equals: 'cpu' }, same).evidence, /no new or changed/);
  const ok = ctxWith({ files: { 'workflows/cpu.yaml': 'name: cpu\n', 'workflows/copy.yaml': 'name: cpu\n' }, fixtures });
  assert.equal(run({ type: 'changed_yaml_equals', dir: 'workflows', at: 'name', equals: 'cpu' }, ok).pass, true);
  const renamed = ctxWith({ files: { 'workflows/cpu.yaml': 'name: cpu\n', 'workflows/other.yaml': 'name: other\n' }, fixtures });
  const res = run({ type: 'changed_yaml_equals', dir: 'workflows', at: 'name', equals: 'cpu' }, renamed);
  assert.equal(res.pass, false);
  assert.match(res.evidence, /other\.yaml/);
  const edited = ctxWith({ files: { 'workflows/cpu.yaml': 'name: renamed\n' }, fixtures });
  assert.equal(run({ type: 'changed_yaml_equals', dir: 'workflows', at: 'name', equals: 'cpu' }, edited).pass, false);
  assert.equal(run({ type: 'changed_yaml_equals', dir: 'missing', at: 'name', equals: 'cpu' }, same).pass, true);
});

test('gradeAssertions: PASS, FAIL, PARTIAL, MANUAL, multi-check aggregation, when_exists, thrown checks', () => {
  const ctx = ctxWith({ files: { 'a.txt': 'x' }, final: 'hello', commands: ['node ok.mjs'] });
  const evalCase = {
    assertions: ['pass', 'fail', 'partial', 'manual', 'both', 'optional file', 'optional file present', 'throws'],
    checks: [
      { assertion: 0, type: 'cmd_matches', pattern: 'ok' },
      { assertion: 1, type: 'cmd_matches', pattern: 'missing' },
      { assertion: 2, type: 'final_includes', text: 'hello', partial: true },
      { assertion: 4, type: 'final_includes', text: 'hello' },
      { assertion: 4, type: 'final_includes', text: 'nope' },
      { assertion: 5, type: 'file_excludes', path: 'b.txt', text: 'x', when_exists: 'b.txt' },
      { assertion: 6, type: 'file_excludes', path: 'a.txt', text: 'y', when_exists: 'a.txt' },
      { assertion: 7, type: 'cmd_matches', pattern: '{skillDir:nope}' },
    ],
  };
  const graded = gradeAssertions(evalCase, ctx);
  assert.deepEqual(graded.map((g) => g.result), ['PASS', 'FAIL', 'PARTIAL', 'MANUAL', 'FAIL', 'PASS', 'PASS', 'FAIL']);
  assert.equal(graded[3].evidence.length, 0);
  assert.equal(graded[4].evidence.length, 2);
  assert.equal(graded[5].evidence[0].evidence, 'b.txt was not written');
  assert.match(graded[7].evidence[0].evidence, /check threw: unknown skill/);
  assert.equal(graded[0].text, 'pass');
  assert.equal(gradeAssertions({ assertions: ['a'] }, ctx)[0].result, 'MANUAL');
});

test('validateChecks: accepts good checks, reports every kind of mistake', () => {
  const opts = { assertionCount: 3, skillNames: ['build'] };
  assert.deepEqual(validateChecks(undefined, opts), []);
  assert.deepEqual(validateChecks([{ assertion: 0, type: 'cmd_matches', pattern: 'a{2}.*{skillDir:build}/x', flags: 'i' }, { assertion: 2, type: 'yaml', path: 'w/a.yaml', at: 'name', equals: 1, partial: true, when_exists: 'w/a.yaml' }], opts), []);
  const bad = validateChecks(
    [
      { assertion: 3, type: 'cmd_matches', pattern: 'x' },
      { assertion: 0, type: 'nope' },
      { assertion: 0, type: 'cmd_matches' },
      { assertion: 0, type: 'cmd_matches', pattern: 'x', extra: 1 },
      { assertion: 0, type: 'cmd_matches', pattern: '(' },
      { assertion: 0, type: 'cmd_matches', pattern: '{skillDir:ghost}' },
      { assertion: 0, type: 'file_exists', path: '../etc' },
      { assertion: 0, type: 'file_exists', path: '/abs' },
      { assertion: 0, type: 'yaml', path: 'a.yaml', at: 'x' },
      { assertion: 0, type: 'yaml', path: 'a.yaml', at: 'x', equals: 1, length: 2 },
      { assertion: 0, type: 'yaml', path: 'a.yaml', at: 'x', keys: 'appName' },
      { assertion: 0, type: 'yaml', path: 'a.yaml', at: 'x', length: -1 },
      { assertion: 0, type: 'skill_no_new_files', skill: 'ghost' },
      { assertion: 0, type: 'final_includes', text: 'a', partial: 'yes' },
      { assertion: 0, type: 'final_includes', text: 'a', when_exists: '/abs' },
      'string',
    ],
    opts,
  );
  const expected = [/assertion" must be an integer from 0 to 2/, /unknown type "nope"/, /missing "pattern"/, /unexpected key "extra"/, /not a valid pattern/, /not a valid pattern.*unknown skill|unknown skill/, /relative path/, /relative path/, /exactly one of/, /exactly one of/, /array of strings/, /non-negative integer/, /not installed/, /"partial" must be a boolean/, /"when_exists" must be a relative path/, /must be an object/];
  assert.equal(bad.length, expected.length, bad.join('\n'));
  expected.forEach((re, i) => assert.match(bad[i], re));
  assert.deepEqual(validateChecks({}, opts), ['"checks" must be an array']);
});

test('the real build-workflow case 1 checks accept the valid fixture as the saved workflow', () => {
  const evals = JSON.parse(readFileSync(new URL('../../../evals/workflow-automation/build-workflow/evals.json', import.meta.url), 'utf8'));
  const evalCase = evals.evals.find((c) => c.id === 1);
  const fixture = readFileSync(new URL('../../../evals/workflow-automation/fixtures/valid/workflows/nrql_hourly_report.yaml', import.meta.url), 'utf8');
  const script = `${PLUGIN}/skills/workflow-automation/build-workflow/scripts/build-workflow.mjs`;
  const ctx = ctxWith({
    files: { 'workflows/nrql_hourly_report.yaml': fixture },
    commands: [`node ${script} env`, `node ${script} describe newrelic.nrdb.query`, `node ${script} describe newrelic.ingest.sendLogs`, `node ${script} write --file /tmp/d.yaml`, `node ${PLUGIN}/skills/workflow-automation/validate-workflow/scripts/validate-workflow.mjs workflows/nrql_hourly_report.yaml`],
  });
  ctx.skillRel = { 'build-workflow': 'skills/workflow-automation/build-workflow', 'validate-workflow': 'skills/workflow-automation/validate-workflow' };
  const graded = gradeAssertions(evalCase, ctx);
  const failing = graded.filter((g) => g.result === 'FAIL').map((g) => `${g.index}: ${JSON.stringify(g.evidence.filter((e) => !e.pass))}`);
  assert.deepEqual(failing, []);
  assert.deepEqual(graded.map((g) => g.result), Array(16).fill('PASS'));

  // A run with no describe calls, --force on the first write, a hardcoded app name, no validation, and a publish call
  // fails exactly those assertions (the script is still invoked by absolute path, so assertion 0 passes).
  const worse = ctxWith({
    files: { 'workflows/nrql_hourly_report.yaml': fixture.replace('${{ .workflowInputs.appName }}\' SINCE', "checkout' SINCE") },
    commands: [`node ${script} write --file /tmp/d.yaml --force`, `node ${PLUGIN}/skills/workflow-automation/publish-workflow/scripts/publish-workflow.mjs plan x`],
  });
  worse.skillRel = ctx.skillRel;
  const failed = gradeAssertions(evalCase, worse).filter((g) => g.result === 'FAIL').map((g) => g.index);
  assert.deepEqual(failed, [2, 3, 9, 13, 14]);
});

test('final_not_matches: passes when the regex is absent, honours flags and lookbehind', () => {
  const ctx = ctxWith({ final: "Please don't paste the key. Export it instead." });
  assert.equal(run({ type: 'final_not_matches', pattern: '\\| error \\|' }, ctx).pass, true);
  assert.equal(run({ type: 'final_not_matches', pattern: "(?<!n['\u2019]t |not |never )paste\\b", flags: 'i' }, ctx).pass, true);
  const bad = ctxWith({ final: 'Just PASTE the key here.' });
  assert.equal(run({ type: 'final_not_matches', pattern: "(?<!n['\u2019]t |not |never )paste\\b", flags: 'i' }, bad).pass, false);
  assert.equal(run({ type: 'final_not_matches', pattern: 'paste' }, bad).pass, true, 'case-sensitive without flags');
});

test('file_matches: regex over the file text; missing file fails', () => {
  const ctx = ctxWith({ files: { 'workflows/a.yaml': 'headers: \'{"X-Pw": "${{ :secrets:PW }}"}\'\n' } });
  const check = { type: 'file_matches', path: 'workflows/a.yaml', pattern: 'X-Pw"\\s*:\\s*"\\$\\{\\{\\s*:secrets:[^}]+\\}\\}"' };
  assert.equal(run(check, ctx).pass, true);
  assert.equal(run({ ...check, pattern: 'nope' }, ctx).pass, false);
  assert.equal(run({ ...check, path: 'workflows/missing.yaml' }, ctx).pass, false);
  assert.deepEqual(validateChecks([{ assertion: 0, ...check }, { assertion: 0, type: 'final_not_matches', pattern: '(' }], { assertionCount: 1, skillNames: [] }).length, 1);
});

const STEPS = (second) => `name: wf\ndescription: d\nsteps:\n  - name: q\n    type: action\n    action: newrelic.nrdb.query\n    version: 1\n    inputs:\n      query: "FROM X SELECT count(*) SINCE 1 hour ago"\n      selectors:\n        - name: n\n          expression: .results[0].n\n  - name: l\n    type: action\n    action: newrelic.ingest.sendLogs\n    version: 1\n    inputs:\n      logs:\n        - message: "${second}"\n`;

test('validate_local: passes a clean workflow; fails on errors, plaintext secrets, missing and unparseable files', () => {
  const clean = readFileSync(new URL('../../../evals/workflow-automation/fixtures/valid/workflows/nrql_hourly_report.yaml', import.meta.url), 'utf8');
  const ctx = ctxWith({ files: { 'workflows/ok.yaml': clean, 'workflows/token.yaml': STEPS('x').replace('inputs:\n      logs:', 'inputs:\n      apiKey: abcdef123456\n      logs:'), 'workflows/noname.yaml': 'description: d\nsteps:\n  - name: a\n    type: action\n    action: x.y\n    version: 1\n', 'workflows/bad.yaml': 'a: [1' } });
  const v = (path) => run({ type: 'validate_local', path }, ctx);
  assert.equal(v('workflows/ok.yaml').pass, true);
  const token = v('workflows/token.yaml');
  assert.equal(token.pass, false);
  assert.match(token.evidence, /plaintext-secret/);
  assert.equal(v('workflows/noname.yaml').pass, false);
  assert.match(v('workflows/bad.yaml').evidence, /1 finding/);
  assert.match(v('workflows/missing.yaml').evidence, /does not exist/);
});

test('step_refs_resolve: refs must name an earlier step and one of its selectors (or success/errorMessage)', () => {
  const sr = (second, extra = {}) => run({ type: 'step_refs_resolve', path: 'workflows/wf.yaml', ...extra }, ctxWith({ files: { 'workflows/wf.yaml': STEPS(second) } }));
  assert.equal(sr('n=${{ .steps.q.outputs.n }}').pass, true);
  assert.equal(sr('ok=${{ .steps.q.outputs.success }}').pass, true);
  assert.match(sr('n=${{ .steps.q.outputs.missing }}').evidence, /q has no selector "missing"/);
  assert.match(sr('n=${{ .steps.zzz.outputs.n }}').evidence, /no earlier step "zzz"/);
  assert.match(sr('n=${{ .steps.l.outputs.success }}').evidence, /no earlier step "l"/, 'a step cannot reference itself');
  assert.match(sr('no refs here').evidence, /no .* reference found/);
  assert.equal(sr('n=${{ .steps.q.outputs.n }}', { at: 'steps.1.inputs.logs' }).pass, true);
  assert.equal(sr('n=${{ .steps.q.outputs.bad }}', { at: 'steps.0' }).pass, false, 'refs outside "at" are not counted');
  assert.match(sr('x', { at: 'nope' }).evidence, /not found/);
  const backwards = ctxWith({ files: { 'workflows/b.yaml': 'name: b\nsteps:\n  - name: a\n    type: action\n    action: x.y\n    version: 1\n    inputs:\n      m: "${{ .steps.b.outputs.success }}"\n  - name: b\n    type: action\n    action: x.y\n    version: 1\n' } });
  assert.match(run({ type: 'step_refs_resolve', path: 'workflows/b.yaml' }, backwards).evidence, /no earlier step "b"/);
  const loop = ctxWith({ files: { 'workflows/l.yaml': 'name: l\nsteps:\n  - name: q\n    type: action\n    action: x.y\n    version: 1\n    inputs:\n      selectors:\n        - name: items\n          expression: .a\n  - name: each\n    type: loop\n    for:\n      in: ${{ .steps.q.outputs.items }}\n      steps:\n        - name: inner\n          type: action\n          action: x.y\n          version: 1\n          inputs:\n            m: "${{ .steps.q.outputs.items }}"\n' } });
  assert.equal(run({ type: 'step_refs_resolve', path: 'workflows/l.yaml' }, loop).pass, true);
  assert.match(run({ type: 'step_refs_resolve', path: 'workflows/none.yaml' }, loop).evidence, /does not exist/);
});

test('validateChecks accepts the new check types and rejects bad arguments', () => {
  const opts = { assertionCount: 2, skillNames: [] };
  assert.deepEqual(validateChecks([{ assertion: 0, type: 'validate_local', path: 'workflows/a.yaml' }, { assertion: 1, type: 'step_refs_resolve', path: 'workflows/a.yaml', at: 'steps.1' }, { assertion: 1, type: 'step_refs_resolve', path: 'workflows/a.yaml' }], opts), []);
  const bad = validateChecks([{ assertion: 0, type: 'validate_local' }, { assertion: 0, type: 'validate_local', path: '/abs' }, { assertion: 0, type: 'step_refs_resolve', path: 'a.yaml', at: 5 }, { assertion: 0, type: 'step_refs_resolve', path: 'a.yaml', extra: 1 }], opts);
  assert.equal(bad.length, 4, bad.join('\n'));
});

test('guards: validateGuards checks the indexes; gradeAssertions passes guard through for every result', () => {
  assert.deepEqual(validateGuards(undefined, { assertionCount: 3 }), []);
  assert.deepEqual(validateGuards([0, 2], { assertionCount: 3 }), []);
  assert.equal(validateGuards([3], { assertionCount: 3 }).length, 1);
  assert.equal(validateGuards([-1, 1.5, 'a'], { assertionCount: 3 }).length, 3);
  assert.match(validateGuards([1, 1], { assertionCount: 3 })[0], /repeat/);
  assert.match(validateGuards('0', { assertionCount: 3 })[0], /must be an array/);
  const ctx = ctxWith({ final: 'hello' });
  const graded = gradeAssertions({ assertions: ['a', 'b', 'c'], guards: [0, 2], checks: [{ assertion: 0, type: 'final_includes', text: 'hello' }, { assertion: 1, type: 'final_includes', text: 'hello' }] }, ctx);
  assert.deepEqual(graded.map((g) => [g.result, g.guard]), [['PASS', true], ['PASS', false], ['MANUAL', true]]);
  assert.equal(gradeAssertions({ assertions: ['a'] }, ctx)[0].guard, false);
});
