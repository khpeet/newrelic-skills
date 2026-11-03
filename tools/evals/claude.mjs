// Runs one eval case through the headless `claude -p` CLI inside a throwaway sandbox, and parses its stream-json
// transcript. Pure builders (buildEnv, buildClaudeArgs, parseTranscript) are exported for unit tests; only
// runClaude spawns a process.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Session variables of the Claude Code instance that launched the runner; a nested session must not inherit them.
const SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_EFFORT',
];

const KILL_GRACE_MS = 10_000;

// The sandboxed `claude -p` gets only these variables from the runner's environment (exact names, or prefixes when they
// end in `*`), so cloud credentials, tokens and agent sockets (AWS_*, GITHUB_TOKEN, SSH_AUTH_SOCK, ...) are never
// inherited. Claude auth/config (ANTHROPIC_*, CLAUDE_CODE_*, CLAUDE_CONFIG_DIR) and proxy/CA settings are kept.
// Anything a family needs beyond this must be a deliberate edit here.
export const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_*', 'TERM', 'USER', 'LOGNAME', 'SHELL',
  'ANTHROPIC_*', 'CLAUDE_CODE_*', 'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
];

const matchesName = (name, entry) => (entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : name === entry);

// The only per-case environment overrides (a case's `env` in evals.json): variable name -> test for its value. A case can
// set NEW_RELIC_API_KEY, and only to a value that starts with `NRAK-INVALID`, so a real key can never be committed to an
// eval file or passed to a run. The sandbox otherwise strips NEW_RELIC_* (unsetEnv); a dummy key lets the agent get past
// the skill scripts' `env` check and reach their auth failure instead of stopping there.
export const CASE_ENV_RULES = {
  NEW_RELIC_API_KEY: { test: (v) => v.startsWith('NRAK-INVALID'), describe: 'a value starting with NRAK-INVALID' },
};

// Returns a list of error strings for a case's `env` (empty when valid). Values are never echoed: a rejected value may be a real key.
export function caseEnvProblems(caseEnv) {
  if (caseEnv === undefined) return [];
  if (!caseEnv || typeof caseEnv !== 'object' || Array.isArray(caseEnv)) return ['"env" must be an object of environment variables'];
  const errors = [];
  for (const [name, value] of Object.entries(caseEnv)) {
    const rule = Object.hasOwn(CASE_ENV_RULES, name) ? CASE_ENV_RULES[name] : null;
    if (!rule) errors.push(`"env" may only set ${Object.keys(CASE_ENV_RULES).join(', ')}, not "${name}"`);
    else if (typeof value !== 'string') errors.push(`"env" ${name} must be a string`);
    else if (!rule.test(value)) errors.push(`"env" ${name} must be ${rule.describe} (the value is not shown)`);
  }
  return errors;
}

// Allowlist first, then remove the session variables of the launching Claude instance and the config's `unsetEnv`
// names (exact, or prefix with a trailing `*`; so NEW_RELIC_* stays out even if allowlisted). `caseEnv` (a case's `env`)
// is applied last, after that stripping, for that run only; it is validated here again and throws on a bad entry.
export function buildEnv(env, { unsetEnv = [], tmpDir, caseEnv }) {
  const problems = caseEnvProblems(caseEnv);
  if (problems.length) throw new Error(problems.join('; '));
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_ALLOWLIST.some((a) => matchesName(name, a))) continue;
    if (SESSION_VARS.includes(name) || unsetEnv.some((u) => matchesName(name, u))) continue;
    out[name] = value;
  }
  Object.assign(out, caseEnv);
  out.TMPDIR = tmpDir.endsWith('/') ? tmpDir : `${tmpDir}/`;
  return out;
}

// `--setting-sources project` stops the user's settings from loading, including the apiKeyHelper that many setups
// authenticate with. Read it back so the eval session can still log in; its value is never printed.
export function readApiKeyHelper(env) {
  try {
    const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const helper = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).apiKeyHelper;
    return typeof helper === 'string' && helper ? helper : null;
  } catch {
    return null;
  }
}

// True when a string has a `..` path segment (also next to a quote, so `"{plugin}/../x"` and `'..'` are caught).
export const hasDotDotSegment = (s) => /(^|[\s/\\'"])\.\.($|[\s/\\'"])/.test(s);

// Why a bashAllow rule body is not acceptable, or null. A `..` segment would let a `skills/../../tmp/x/y.mjs` path walk out
// of the installed skills into a script the agent wrote itself, and a wildcard inside the sandbox-plugin path would let any
// file under it match, so such entries must name exact script paths. `pluginDir` is what to look for in the rule:
// `{plugin}` before substitution, the real directory after it.
export function bashRuleProblem(rule, pluginDir = '{plugin}') {
  if (hasDotDotSegment(rule)) return `contains a ".." path segment: ${rule}`;
  const wild = rule.split(/\s+/).find((t) => t.includes(pluginDir) && /[*?[\]]/.test(t));
  if (wild) return `has a wildcard in the sandbox plugin path (${wild}); list exact script paths instead: ${rule}`;
  return null;
}

// Path-scoped on purpose: an unscoped Write/Read rule lets the agent touch files anywhere on the machine. `//` makes a
// rule absolute from the filesystem root. Glob and Grep are deliberately not listed: an allow rule with no path would let
// them search anywhere (for example ~/.aws or ~/.claude) and put the hits in the saved transcript, and Claude Code has no
// path-scoped allow rule for them. Without a rule they stay read-only tools that run unprompted only inside the working
// directories (project/, plus --add-dir tmp/ and plugin/) and are denied elsewhere in a headless run.
// `{plugin}` in a bashAllow entry becomes the sandbox plugin dir, so Bash can be limited to exact installed skill scripts.
// Throws on an entry with a `..` segment or a wildcard in the plugin path.
export function buildAllowedTools({ bashAllow = [], sandbox }) {
  for (const [name, dir] of Object.entries(sandbox)) {
    if (typeof dir === 'string' && hasDotDotSegment(dir)) throw new Error(`sandbox ${name} path contains a ".." path segment: ${dir}`);
  }
  const abs = (p) => `/${p}`;
  const bash = bashAllow.map((b) => {
    const rule = b.replaceAll('{plugin}', sandbox.plugin);
    const problem = bashRuleProblem(rule, sandbox.plugin);
    if (problem) throw new Error(`bashAllow entry "${b}" ${problem}`);
    return `Bash(${rule})`;
  });
  return ['Skill', ...bash, `Read(${abs(sandbox.root)}/**)`, `Edit(${abs(sandbox.project)}/**)`, `Edit(${abs(sandbox.tmp)}/**)`].join(' ');
}

// `allowedTools` replaces the default tool rules; `maxTurns` adds --max-turns (the run then ends with subtype error_max_turns).
export function buildClaudeArgs({ prompt, sandbox, bashAllow, withSkill, model, maxBudgetUsd, maxTurns, allowedTools, apiKeyHelper }) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence'];
  if (apiKeyHelper) args.push('--settings', JSON.stringify({ apiKeyHelper }));
  if (withSkill) args.push('--plugin-dir', sandbox.plugin);
  args.push('--add-dir', sandbox.tmp);
  if (withSkill) args.push(sandbox.plugin);
  args.push('--allowedTools', allowedTools ?? buildAllowedTools({ bashAllow, sandbox }), '--max-budget-usd', String(maxBudgetUsd));
  if (maxTurns) args.push('--max-turns', String(maxTurns));
  if (model) args.push('--model', model);
  return args;
}

export function redactArgs(args) {
  return args.map((a, i) => (args[i - 1] === '--settings' ? '<redacted>' : a));
}

// Creates <root>/{project,tmp[,plugin]} under a fresh realpath'd temp dir. `skills` are {family, name, dir}; the plugin
// manifest is synthesized from them so it does not depend on the repo's own plugin.json.
export function createSandbox({ pluginName, skills, familyDir, files, withSkill }) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'nr-evals-'));
  const sandbox = { root, project: join(root, 'project'), tmp: join(root, 'tmp'), plugin: join(root, 'plugin'), skillRel: {} };
  mkdirSync(sandbox.project);
  mkdirSync(sandbox.tmp);
  for (const file of files) {
    const m = /^fixtures\/[^/]+\/(.+)$/.exec(file);
    if (!m) throw new Error(`fixture path must look like fixtures/<case>/<path>: ${file}`);
    if (hasDotDotSegment(file)) throw new Error(`fixture path contains a ".." path segment: ${file}`);
    mkdirSync(dirname(join(sandbox.project, m[1])), { recursive: true });
    cpSync(join(familyDir, file), join(sandbox.project, m[1]));
  }
  // skillRel is set for baseline runs too, so {skillDir:x} placeholders in checks still expand (to a path that never exists).
  for (const skill of skills) sandbox.skillRel[skill.name] = `skills/${skill.family}/${skill.name}`;
  if (withSkill) {
    mkdirSync(join(sandbox.plugin, '.claude-plugin'), { recursive: true });
    for (const skill of skills) cpSync(skill.dir, join(sandbox.plugin, sandbox.skillRel[skill.name]), { recursive: true });
    const manifest = { name: pluginName, version: '0.0.0-eval', skills: skills.map((s) => `./${sandbox.skillRel[s.name]}`) };
    writeFileSync(join(sandbox.plugin, '.claude-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return sandbox;
}

// {relative path -> sha256} for every file under dir.
export function hashTree(dir, base = dir, out = {}) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) hashTree(full, base, out);
    else if (entry.isFile()) out[full.slice(base.length + 1)] = createHash('sha256').update(readFileSync(full)).digest('hex');
  }
  return out;
}

export function diffTrees(before, after) {
  return {
    newFiles: Object.keys(after).filter((f) => !(f in before)).sort(),
    changedFiles: Object.keys(after).filter((f) => f in before && before[f] !== after[f]).sort(),
  };
}

// Spawns `claude`, streaming stdout/stderr to files. Never rejects: failures come back in the result.
export function runClaude({ args, cwd, env, transcriptPath, stderrPath, timeoutMs }) {
  return new Promise((resolve) => {
    const out = openSync(transcriptPath, 'w');
    const err = openSync(stderrPath, 'w');
    let timedOut = false;
    let killTimer;
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', out, err] });
    const done = (result) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      closeSync(out);
      closeSync(err);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);
    child.on('error', (e) => done({ exitCode: null, signal: null, timedOut, spawnError: e.code ?? e.message }));
    child.on('close', (exitCode, signal) => done({ exitCode, signal, timedOut, spawnError: null }));
  });
}

// Reads the stream-json transcript. Bash commands and Skill calls come from every assistant tool_use block in stream
// order, subagent events included.
export function parseTranscript(text) {
  const parsed = { init: null, commands: [], skillCalls: [], toolResults: {}, final: '', result: null, permissionDenials: [], skippedLines: 0 };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      parsed.skippedLines += 1;
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init') parsed.init = event;
    else if (event.type === 'result') parsed.result = event;
    else if (event.type === 'assistant' || event.type === 'user') {
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const block of content) {
        if (block.type === 'tool_use' && block.name === 'Bash' && typeof block.input?.command === 'string') parsed.commands.push(block.input.command);
        else if (block.type === 'tool_use' && block.name === 'Skill' && block.input?.skill) parsed.skillCalls.push(block.input.skill);
        else if (block.type === 'tool_result') parsed.toolResults[block.tool_use_id] = { is_error: block.is_error ?? false, content: block.content };
      }
    }
  }
  parsed.final = typeof parsed.result?.result === 'string' ? parsed.result.result : '';
  parsed.permissionDenials = parsed.result?.permission_denials ?? [];
  return parsed;
}

export function timingFrom(parsed, wallMs) {
  const u = parsed.result?.usage ?? {};
  return {
    total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    duration_ms: parsed.result?.duration_ms ?? wallMs,
    total_cost_usd: parsed.result?.total_cost_usd ?? 0,
    num_turns: parsed.result?.num_turns ?? 0,
  };
}

// True when the run did not finish cleanly: the CLI errored, was cut off, or never produced a result.
export function runError(parsed, meta) {
  if (meta.spawnError) return `could not start claude: ${meta.spawnError}`;
  if (meta.timedOut) return 'timed out';
  if (!parsed.result) return 'no result event in the transcript';
  if (parsed.result.is_error) return `claude reported an error: ${String(parsed.final).split('\n')[0]}`;
  if (parsed.result.terminal_reason && parsed.result.terminal_reason !== 'completed') return `terminal_reason ${parsed.result.terminal_reason}`;
  if (meta.exitCode) return `claude exited with code ${meta.exitCode}`;
  return null;
}
