// Shared builders for the eval-runner tests: a throwaway repo with one family ("demo"), and fake saved runs.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const write = (file, text) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

export const DEFAULT_CHECKS = [
  { assertion: 0, type: 'cmd_matches', pattern: 'node\\s+{skillDir:hello}/scripts/hello\\.mjs' },
  { assertion: 1, type: 'file_unchanged', path: 'workflows/a.yaml' },
];

export function makeRepo({ checks = DEFAULT_CHECKS, config, triggers, guards, env } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'run-evals-test-'));
  write(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'demo-plugin' }] }));
  write(join(root, 'skills', 'demo', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: Says hello.\n---\nhi\n');
  write(join(root, 'skills', 'demo', 'hello', 'scripts', 'hello.mjs'), 'console.log("hi")\n');
  write(join(root, 'evals', 'demo', 'config.json'), JSON.stringify(config ?? { plugin: 'demo-plugin', install: ['demo'], unsetEnv: ['DEMO_*', 'NEW_RELIC_API_KEY'], bashAllow: ['node:*'] }));
  write(join(root, 'evals', 'demo', 'fixtures', 'c1', 'workflows', 'a.yaml'), 'name: a\n');
  write(
    join(root, 'evals', 'demo', 'hello', 'evals.json'),
    JSON.stringify({
      skill_name: 'hello',
      evals: [{ id: 1, prompt: 'say hi', expected_output: 'hi', files: ['fixtures/c1/workflows/a.yaml'], assertions: ['ran the script', 'a.yaml is untouched', 'is polite'], checks, ...(guards && { guards }), ...(env !== undefined && { env }) }],
    }),
  );
  if (triggers) write(join(root, 'evals', 'demo', 'triggers.json'), JSON.stringify(triggers));
  return root;
}

export const event = (e) => `${JSON.stringify(e)}\n`;

// A stream-json transcript with the given Bash commands and a final result.
export function transcript({ commands = [], skills = [], final = 'done', result = {} } = {}) {
  const blocks = [
    ...skills.map((skill, i) => ({ type: 'tool_use', id: `s${i}`, name: 'Skill', input: { skill } })),
    ...commands.map((command, i) => ({ type: 'tool_use', id: `b${i}`, name: 'Bash', input: { command } })),
  ];
  return (
    event({ type: 'system', subtype: 'init', cwd: '/x' }) +
    event({ type: 'assistant', message: { content: blocks } }) +
    event({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: final, duration_ms: 1500, total_cost_usd: 0.25, num_turns: 3, permission_denials: [], usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }, ...result })
  );
}

// Writes the artifacts execute() would have saved for one run and returns the run directory.
export function saveRun(root, { iteration = 1, variant = 'with_skill', commands = [], final = 'done', projectFiles = { 'workflows/a.yaml': 'name: a\n' }, meta = {}, result = {} } = {}) {
  const dir = join(root, 'evals', 'workspace', 'demo', `iteration-${iteration}`, 'hello', 'eval-1', variant);
  const sandbox = '/private/var/folders/xx/nr-evals-AAAA';
  write(join(dir, 'transcript.jsonl'), transcript({ commands, final, result }));
  write(join(dir, 'timing.json'), JSON.stringify({ total_tokens: 100, duration_ms: 1500, total_cost_usd: 0.25, num_turns: 3 }));
  write(
    join(dir, 'meta.json'),
    JSON.stringify({ paths: { sandbox, project: `${sandbox}/project`, tmp: `${sandbox}/tmp`, plugin: `${sandbox}/plugin` }, skillRel: { hello: 'skills/demo/hello' }, exitCode: 0, signal: null, timedOut: false, spawnError: null, pluginNewFiles: [], pluginChangedFiles: [], ...meta }),
  );
  mkdirSync(join(dir, 'project'), { recursive: true });
  for (const [rel, text] of Object.entries(projectFiles)) write(join(dir, 'project', rel), text);
  return dir;
}

// Writes the artifacts a triggers execute() would have saved for one query: `reps` is one entry per repetition,
// {skills, result, meta}, and the query-level meta.json and timing.json. Returns the query directory.
export function saveTriggerRun(root, { iteration = 1, skill = 'hello', id = 1, reps = [{}], query = 'say hi', shouldTrigger = true } = {}) {
  const dir = join(root, 'evals', 'workspace', 'demo', `iteration-${iteration}`, 'triggers', skill, `q-${id}`);
  reps.forEach(({ skills = [], result = { subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns' }, meta = {} }, i) => {
    const rep = join(dir, `run-${i + 1}`);
    write(join(rep, 'transcript.jsonl'), transcript({ skills, result }));
    write(join(rep, 'timing.json'), JSON.stringify({ total_tokens: 100, duration_ms: 1500, total_cost_usd: 0.05, num_turns: 2 }));
    write(join(rep, 'meta.json'), JSON.stringify({ run: i + 1, exitCode: 1, signal: null, timedOut: false, spawnError: null, ...meta }));
  });
  write(join(dir, 'timing.json'), JSON.stringify({ total_tokens: 100 * reps.length, duration_ms: 1500 * reps.length, total_cost_usd: 0.05 * reps.length, num_turns: 2 * reps.length }));
  write(join(dir, 'meta.json'), JSON.stringify({ kind: 'triggers', skill, caseId: id, query, should_trigger: shouldTrigger, runs: reps.length }));
  return dir;
}

export const capture = () => ({ text: '', write(s) { this.text += s; } });
