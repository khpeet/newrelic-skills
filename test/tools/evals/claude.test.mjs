import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASE_ENV_RULES, ENV_ALLOWLIST, bashRuleProblem, caseEnvProblems, buildAllowedTools, buildClaudeArgs, buildEnv, createSandbox, diffTrees, hashTree, parseTranscript, readApiKeyHelper, redactArgs, runError, timingFrom } from '../../../tools/evals/claude.mjs';
import { transcript, write } from './helpers.mjs';

const sandbox = { root: '/private/var/x/nr-evals-1', project: '/private/var/x/nr-evals-1/project', tmp: '/private/var/x/nr-evals-1/tmp', plugin: '/private/var/x/nr-evals-1/plugin' };

test('buildEnv: passes only allowlisted variables, strips unsetEnv names/prefixes and the session variables, sets TMPDIR', () => {
  const env = buildEnv(
    { NEW_RELIC_API_KEY: 'k', NEW_RELIC_REGION: 'EU', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_EFFORT: 'high', ANTHROPIC_BASE_URL: 'https://x', PATH: '/bin', EXACT: 'v', CLAUDE_CODE_OAUTH_TOKEN: 'o', LC_ALL: 'C', ANTHROPIC_EXTRA: 'e' },
    { unsetEnv: ['ANTHROPIC_EXTRA', 'CLAUDE_CODE_OAUTH_*'], tmpDir: '/t/tmp' },
  );
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_BASE_URL', 'LC_ALL', 'PATH', 'TMPDIR']);
  assert.equal(env.TMPDIR, '/t/tmp/');
});

test('buildEnv: secrets outside the allowlist are not inherited; PATH, HOME and Claude auth are', () => {
  const env = buildEnv(
    { AWS_SECRET_ACCESS_KEY: 'a', AWS_ACCESS_KEY_ID: 'b', GITHUB_TOKEN: 'g', SSH_AUTH_SOCK: '/s', NEW_RELIC_API_KEY: 'n', PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk', HTTPS_PROXY: 'http://p', NODE_EXTRA_CA_CERTS: '/ca.pem' },
    { unsetEnv: ['NEW_RELIC_*'], tmpDir: '/t/tmp' },
  );
  for (const name of ['AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'NEW_RELIC_API_KEY']) assert.ok(!(name in env), name);
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'HOME', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'PATH', 'TMPDIR']);
});

test('buildEnv: NEW_RELIC_* stays out even when unsetEnv is empty and the allowlist never names the session variables', () => {
  assert.ok(!('NEW_RELIC_API_KEY' in buildEnv({ NEW_RELIC_API_KEY: 'k' }, { tmpDir: '/t' })));
  assert.ok(!ENV_ALLOWLIST.some((a) => a.startsWith('NEW_RELIC')));
  assert.ok(!('CLAUDE_CODE_SESSION_ID' in buildEnv({ CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_ENTRYPOINT: 'cli' }, { tmpDir: '/t' })));
});

const DUMMY_KEY = 'NRAK-INVALID-EVAL-DUMMY-KEY-0000000000';

test('caseEnvProblems: accepts only NEW_RELIC_API_KEY with an NRAK-INVALID value, and never echoes a rejected value', () => {
  assert.deepEqual(caseEnvProblems(undefined), []);
  assert.deepEqual(caseEnvProblems({}), []);
  assert.deepEqual(caseEnvProblems({ NEW_RELIC_API_KEY: DUMMY_KEY }), []);
  assert.deepEqual(Object.keys(CASE_ENV_RULES), ['NEW_RELIC_API_KEY']);
  // another variable, even a harmless one, or an inherited property name
  for (const name of ['NEW_RELIC_ACCOUNT_ID', 'NEW_RELIC_REGION', 'GITHUB_TOKEN', 'PATH', 'toString', '__proto__']) {
    const input = JSON.parse(`{"${name}":"${DUMMY_KEY}"}`);
    assert.match(caseEnvProblems(input)[0], /"env" may only set NEW_RELIC_API_KEY/, name);
  }
  // a real-looking key, wrong case, a prefix elsewhere in the string, empty
  const real = `NRAK-${'A1'.repeat(13)}Z`;
  for (const value of [real, 'nrak-invalid-x', ` ${DUMMY_KEY}`, `X${DUMMY_KEY}`, 'NRAK-invalid', '']) {
    const [problem] = caseEnvProblems({ NEW_RELIC_API_KEY: value });
    assert.match(problem, /must be a value starting with NRAK-INVALID/);
    assert.ok(!problem.includes(value) || value === '', 'the rejected value is not echoed');
  }
  // non-string values and a non-object env
  for (const value of [1, null, true, ['NRAK-INVALID'], { a: 1 }]) assert.match(caseEnvProblems({ NEW_RELIC_API_KEY: value })[0], /must be a string/);
  for (const bad of [null, 'NRAK-INVALID', ['NRAK-INVALID'], 3]) assert.match(caseEnvProblems(bad)[0], /"env" must be an object/);
});

test('buildEnv: a case env is applied after unsetEnv for that run only; a bad case env throws without echoing the value', () => {
  const inherited = { NEW_RELIC_API_KEY: 'NRAK-REAL-FROM-SHELL', PATH: '/bin' };
  const withCase = buildEnv(inherited, { unsetEnv: ['NEW_RELIC_*'], tmpDir: '/t/tmp', caseEnv: { NEW_RELIC_API_KEY: DUMMY_KEY } });
  assert.equal(withCase.NEW_RELIC_API_KEY, DUMMY_KEY, 'overrides the stripped shell key');
  assert.deepEqual(Object.keys(withCase).sort(), ['NEW_RELIC_API_KEY', 'PATH', 'TMPDIR']);
  // no case env: still stripped
  for (const caseEnv of [undefined, {}]) assert.ok(!('NEW_RELIC_API_KEY' in buildEnv(inherited, { unsetEnv: ['NEW_RELIC_*'], tmpDir: '/t', caseEnv })));
  // defensive re-check at build time
  assert.throws(() => buildEnv(inherited, { tmpDir: '/t', caseEnv: { NEW_RELIC_API_KEY: 'NRAK-REALLY-SECRET' } }), (e) => /must be a value starting with NRAK-INVALID/.test(e.message) && !e.message.includes('REALLY-SECRET'));
  assert.throws(() => buildEnv(inherited, { tmpDir: '/t', caseEnv: { AWS_SECRET_ACCESS_KEY: 'x' } }), /may only set NEW_RELIC_API_KEY/);
});

test('buildAllowedTools: path-scoped Read/Edit with // absolute roots, no unscoped file tools (including Glob and Grep)', () => {
  const rules = buildAllowedTools({ bashAllow: ['node:*'], sandbox });
  assert.equal(rules, 'Skill Bash(node:*) Read(//private/var/x/nr-evals-1/**) Edit(//private/var/x/nr-evals-1/project/**) Edit(//private/var/x/nr-evals-1/tmp/**)');
  assert.doesNotMatch(rules, /(^| )(Read|Write|Edit|Glob|Grep)( |$)/);
  assert.doesNotMatch(rules, /Glob|Grep/);
  assert.doesNotMatch(buildAllowedTools({ sandbox }), /Bash/);
});

test('buildAllowedTools: {plugin} in bashAllow becomes the sandbox plugin dir (exact script path, trailing * for arguments)', () => {
  const rules = buildAllowedTools({ bashAllow: ['node {plugin}/skills/demo/hello/scripts/hello.mjs *'], sandbox });
  assert.match(rules, /Bash\(node \/private\/var\/x\/nr-evals-1\/plugin\/skills\/demo\/hello\/scripts\/hello\.mjs \*\)/);
  assert.doesNotMatch(rules, /\{plugin\}/);
});

test('buildAllowedTools: rejects a bashAllow entry with a ".." segment or a wildcard in the plugin path', () => {
  const allow = (b) => () => buildAllowedTools({ bashAllow: [b], sandbox });
  assert.throws(allow('node {plugin}/skills/../../tmp/x/scripts/y.mjs *'), /"\.\." path segment/);
  assert.throws(allow('node {plugin}/skills/demo/hello/scripts/..'), /"\.\." path segment/);
  assert.throws(allow('node "{plugin}/skills/demo/../x.mjs" *'), /"\.\." path segment/);
  assert.throws(allow('node ../x.mjs *'), /"\.\." path segment/);
  assert.throws(allow('node {plugin}/skills/*/scripts/*.mjs *'), /wildcard in the sandbox plugin path/);
  assert.throws(allow('node {plugin}/skills/demo/hello/scripts/hello?.mjs *'), /wildcard/);
  // dots inside a name are fine, and a wildcard outside the plugin path (the argument list) is the intended form
  assert.doesNotThrow(allow('node {plugin}/skills/demo/hello/scripts/hello..v2.mjs *'));
  assert.doesNotThrow(allow('node:*'));
});

test('buildAllowedTools: rejects a sandbox path with a ".." segment', () => {
  assert.throws(() => buildAllowedTools({ sandbox: { ...sandbox, tmp: '/private/var/x/../y/tmp' } }), /sandbox tmp path/);
});

test('bashRuleProblem: checks the {plugin} placeholder before substitution too', () => {
  assert.equal(bashRuleProblem('node {plugin}/skills/demo/hello/scripts/hello.mjs *'), null);
  assert.match(bashRuleProblem('node {plugin}/skills/*/scripts/*.mjs *'), /wildcard/);
  assert.match(bashRuleProblem('node {plugin}/../x.mjs *'), /\.\./);
});

test('buildClaudeArgs: with_skill loads the plugin and its dir; without_skill does neither', () => {
  const base = { prompt: 'hi', sandbox, bashAllow: ['node:*'], model: 'sonnet', maxBudgetUsd: 2, apiKeyHelper: null };
  const withSkill = buildClaudeArgs({ ...base, withSkill: true });
  assert.deepEqual(withSkill.slice(0, 9), ['-p', 'hi', '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence']);
  assert.equal(withSkill[withSkill.indexOf('--plugin-dir') + 1], sandbox.plugin);
  const addDir = withSkill.indexOf('--add-dir');
  assert.deepEqual(withSkill.slice(addDir, addDir + 3), ['--add-dir', sandbox.tmp, sandbox.plugin]);
  assert.ok(!withSkill.includes('--settings'));
  assert.deepEqual(withSkill.slice(-4), ['--max-budget-usd', '2', '--model', 'sonnet']);

  const baseline = buildClaudeArgs({ ...base, withSkill: false, model: undefined });
  assert.ok(!baseline.includes('--plugin-dir'));
  assert.ok(!baseline.includes(sandbox.plugin));
  assert.equal(baseline.includes('--model'), false);
});

test('buildClaudeArgs / redactArgs: the apiKeyHelper is passed through --settings and redacted for logs', () => {
  const args = buildClaudeArgs({ prompt: 'hi', sandbox, bashAllow: [], withSkill: false, maxBudgetUsd: 1, apiKeyHelper: '/bin/get-key --secret' });
  assert.equal(args[args.indexOf('--settings') + 1], '{"apiKeyHelper":"/bin/get-key --secret"}');
  const redacted = redactArgs(args);
  assert.equal(redacted[redacted.indexOf('--settings') + 1], '<redacted>');
  assert.ok(!JSON.stringify(redacted).includes('get-key'));
});

test('readApiKeyHelper: reads a string helper from CLAUDE_CONFIG_DIR/settings.json, otherwise null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  assert.equal(readApiKeyHelper({ CLAUDE_CONFIG_DIR: dir }), null);
  writeFileSync(join(dir, 'settings.json'), '{"apiKeyHelper":"/bin/key"}');
  assert.equal(readApiKeyHelper({ CLAUDE_CONFIG_DIR: dir }), '/bin/key');
  writeFileSync(join(dir, 'settings.json'), '{"apiKeyHelper":5}');
  assert.equal(readApiKeyHelper({ CLAUDE_CONFIG_DIR: dir }), null);
  writeFileSync(join(dir, 'settings.json'), 'not json');
  assert.equal(readApiKeyHelper({ CLAUDE_CONFIG_DIR: dir }), null);
});

test('createSandbox: copies fixtures without the fixtures/<case>/ prefix and builds a plugin manifest listing every skill', () => {
  const familyDir = mkdtempSync(join(tmpdir(), 'fam-'));
  write(join(familyDir, 'fixtures', 'c1', 'workflows', 'a.yaml'), 'name: a\n');
  const skillDir = mkdtempSync(join(tmpdir(), 'skill-'));
  write(join(skillDir, 'SKILL.md'), 'x');
  write(join(skillDir, 'scripts', 's.mjs'), 'y');
  const skills = [{ family: 'demo', name: 'one', dir: skillDir }, { family: 'demo', name: 'two', dir: skillDir }];

  const sb = createSandbox({ pluginName: 'demo-plugin', skills, familyDir, files: ['fixtures/c1/workflows/a.yaml'], withSkill: true });
  assert.equal(sb.root, realpathSync(sb.root));
  assert.equal(readFileSync(join(sb.project, 'workflows', 'a.yaml'), 'utf8'), 'name: a\n');
  assert.ok(existsSync(sb.tmp));
  const manifest = JSON.parse(readFileSync(join(sb.plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepEqual(manifest, { name: 'demo-plugin', version: '0.0.0-eval', skills: ['./skills/demo/one', './skills/demo/two'] });
  assert.ok(existsSync(join(sb.plugin, 'skills', 'demo', 'two', 'scripts', 's.mjs')));

  const baseline = createSandbox({ pluginName: 'demo-plugin', skills, familyDir, files: [], withSkill: false });
  assert.ok(!existsSync(baseline.plugin));
  assert.deepEqual(baseline.skillRel, { one: 'skills/demo/one', two: 'skills/demo/two' });

  assert.throws(() => createSandbox({ pluginName: 'p', skills, familyDir, files: ['nope/a.yaml'], withSkill: false }), /fixtures\/<case>/);
});

test('createSandbox: rejects a fixture or triggerFile path with a ".." segment', () => {
  const familyDir = mkdtempSync(join(tmpdir(), 'fam-'));
  write(join(familyDir, 'fixtures', 'c1', 'a.yaml'), 'name: a\n');
  write(join(familyDir, 'secret.txt'), 's');
  for (const bad of ['fixtures/c1/../../secret.txt', 'fixtures/c1/..']) {
    assert.throws(() => createSandbox({ pluginName: 'p', skills: [], familyDir, files: [bad], withSkill: false }), /"\.\." path segment/, bad);
  }
});

test('hashTree / diffTrees: report new and changed files, relative to the root', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tree-'));
  write(join(dir, 'a', 'one.txt'), '1');
  write(join(dir, 'two.txt'), '2');
  const before = hashTree(dir);
  assert.deepEqual(Object.keys(before).sort(), ['a/one.txt', 'two.txt']);
  write(join(dir, 'two.txt'), 'changed');
  write(join(dir, 'a', 'new.txt'), 'n');
  assert.deepEqual(diffTrees(before, hashTree(dir)), { newFiles: ['a/new.txt'], changedFiles: ['two.txt'] });
  assert.deepEqual(hashTree(join(dir, 'missing')), {});
});

test('parseTranscript: commands in order (subagents included), skill calls, tool results, final text, denials, junk skipped', () => {
  const text =
    'warning: not json\n' +
    transcript({ commands: ['ls', 'node /x.mjs'], skills: ['p:skill'], final: 'all done', result: { permission_denials: [{ tool_name: 'Bash' }] } }) +
    `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b0', is_error: true, content: 'blocked' }] } })}\n` +
    `${JSON.stringify({ type: 'assistant', parent_tool_use_id: 'x', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'from subagent' } }, { type: 'text', text: 'hi' }] } })}\n`;
  const p = parseTranscript(text);
  assert.deepEqual(p.commands, ['ls', 'node /x.mjs', 'from subagent']);
  assert.deepEqual(p.skillCalls, ['p:skill']);
  assert.deepEqual(p.toolResults.b0, { is_error: true, content: 'blocked' });
  assert.equal(p.final, 'all done');
  assert.equal(p.permissionDenials.length, 1);
  assert.equal(p.skippedLines, 1);
  assert.equal(p.init.cwd, '/x');
});

test('parseTranscript: an empty or truncated transcript has no result and an empty final', () => {
  const p = parseTranscript('{"type":"system","subtype":"init"}\n{"type":"assis');
  assert.equal(p.result, null);
  assert.equal(p.final, '');
  assert.equal(p.skippedLines, 1);
});

test('timingFrom: sums the four token fields, falls back to wall time without a result', () => {
  assert.deepEqual(timingFrom(parseTranscript(transcript()), 9999), { total_tokens: 100, duration_ms: 1500, total_cost_usd: 0.25, num_turns: 3 });
  assert.deepEqual(timingFrom(parseTranscript(''), 777), { total_tokens: 0, duration_ms: 777, total_cost_usd: 0, num_turns: 0 });
});

test('runError: spawn failure, timeout, missing result, is_error, terminal_reason, exit code; null when clean', () => {
  const clean = { exitCode: 0, timedOut: false, spawnError: null };
  const ok = parseTranscript(transcript());
  assert.equal(runError(ok, clean), null);
  assert.match(runError(ok, { ...clean, spawnError: 'ENOENT' }), /could not start claude: ENOENT/);
  assert.equal(runError(ok, { ...clean, timedOut: true }), 'timed out');
  assert.match(runError(parseTranscript(''), clean), /no result event/);
  assert.match(runError(parseTranscript(transcript({ result: { is_error: true }, final: 'API Error: 400' })), clean), /API Error: 400/);
  assert.match(runError(parseTranscript(transcript({ result: { terminal_reason: 'max_turns' } })), clean), /max_turns/);
  assert.match(runError(ok, { ...clean, exitCode: 1 }), /exited with code 1/);
});

test('buildClaudeArgs: maxTurns adds --max-turns before the model; allowedTools replaces the default rules', () => {
  const base = { prompt: 'hi', sandbox, bashAllow: ['node:*'], withSkill: true, model: 'sonnet', maxBudgetUsd: 1, apiKeyHelper: null };
  const turns = buildClaudeArgs({ ...base, maxTurns: 2 });
  assert.deepEqual(turns.slice(-6), ['--max-budget-usd', '1', '--max-turns', '2', '--model', 'sonnet']);
  assert.ok(!buildClaudeArgs(base).includes('--max-turns'));
  const only = buildClaudeArgs({ ...base, allowedTools: 'Skill' });
  assert.equal(only[only.indexOf('--allowedTools') + 1], 'Skill');
  assert.equal(buildClaudeArgs(base)[buildClaudeArgs(base).indexOf('--allowedTools') + 1], buildAllowedTools({ bashAllow: ['node:*'], sandbox }));
});
