// Eval kind "triggers": evals/<family>/triggers.json holds {"<skill>": [{query, should_trigger}]}. Each query is one run;
// `execute` sends it to `claude -p` several times (--runs) with the family's skills installed, stopping after two turns,
// and records whether the model called the skill. `grade` turns the trigger rate into PASS or FAIL.
// Kind interface (see evals/README.md): discover, plan, outDir, execute, grade, plus the optional summarize and progress hooks.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeArgs, buildEnv, createSandbox, parseTranscript, readApiKeyHelper, redactArgs, runClaude, runError, timingFrom } from '../claude.mjs';

// The first assistant turn decides whether a skill is called; the second lets a skill that loads on turn one finish loading.
const MAX_TURNS = 2;
const BUDGET_CAP_USD = 0.25;
const QUERY_KEYS = ['query', 'should_trigger'];

const writeJson = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
// "nr-workflow-automation:fetch-workflow" -> "fetch-workflow"
const skillName = (called) => called.slice(called.lastIndexOf(':') + 1);
const isMaxTurns = (result) => result?.subtype === 'error_max_turns' || result?.terminal_reason === 'max_turns';
const round = (n) => Number(n.toFixed(4));
const ratio = (n, d) => (d ? round(n / d) : null);

// A stop at --max-turns is how every trigger run ends, so it is not an error; anything else is judged as in the output kind.
function repError(parsed, meta) {
  if (meta.spawnError) return `could not start claude: ${meta.spawnError}`;
  if (meta.timedOut) return 'timed out';
  if (!parsed.result) return 'no result event in the transcript';
  if (isMaxTurns(parsed.result)) return null;
  return runError(parsed, meta);
}

const budgetFor = (ctx) => Math.min(ctx.maxBudgetUsd, BUDGET_CAP_USD);

function claudeArgs(run, ctx, sandbox) {
  return buildClaudeArgs({ prompt: run.query, sandbox, bashAllow: [], withSkill: true, model: ctx.model, maxBudgetUsd: budgetFor(ctx), maxTurns: MAX_TURNS, apiKeyHelper: readApiKeyHelper(ctx.env) });
}

const repDirs = (outDir) =>
  readdirSync(outDir)
    .map((name) => /^run-(\d+)$/.exec(name))
    .filter(Boolean)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => ({ k: Number(m[1]), dir: join(outDir, m[0]) }));

export default {
  name: 'triggers',

  // Returns one run per query. A family without a triggers.json has none. Throws one error listing every problem.
  discover({ family, familyDir, config, skills, root }) {
    const file = join(familyDir, 'triggers.json');
    if (!existsSync(file)) return [];
    const where = `evals/${family}/triggers.json`;
    let data;
    try {
      data = readJson(file);
    } catch (e) {
      throw new Error(`${where}: ${e.message}`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${where}: must be an object of {"<skill>": [{query, should_trigger}]}`);
    const skillNames = skills.map((s) => s.name);
    const runs = [];
    const errors = [];
    for (const [skill, queries] of Object.entries(data)) {
      if (!skillNames.includes(skill)) {
        errors.push(`${where}: "${skill}" is not an installed skill (${skillNames.join(', ')})`);
        continue;
      }
      if (!Array.isArray(queries) || !queries.length) {
        errors.push(`${where}: "${skill}" must be a non-empty array`);
        continue;
      }
      queries.forEach((q, i) => {
        const label = `${where} ${skill}[${i}]`;
        const problems = [];
        if (!q || typeof q !== 'object' || Array.isArray(q)) problems.push(`${label}: must be an object`);
        else {
          for (const key of Object.keys(q)) if (!QUERY_KEYS.includes(key)) problems.push(`${label}: unknown key "${key}"`);
          if (typeof q.query !== 'string' || !q.query.trim()) problems.push(`${label}: "query" must be a non-empty string`);
          if (typeof q.should_trigger !== 'boolean') problems.push(`${label}: "should_trigger" must be a boolean`);
        }
        errors.push(...problems);
        if (problems.length) return;
        const caseId = i + 1;
        runs.push({ kind: 'triggers', family, skill, caseId, variant: 'with_skill', query: q.query, shouldTrigger: q.should_trigger, familyDir, config, skills, root, label: `${family}/${skill} q-${caseId} ${q.should_trigger ? 'should' : 'should-not'} trigger` });
      });
    }
    if (errors.length) throw new Error(errors.join('\n'));
    return runs;
  },

  outDir: (run) => join('triggers', run.skill, `q-${run.caseId}`),

  // Dry run: the redacted claude arguments for a fake sandbox path, and how many times the query is sent.
  plan(run, ctx) {
    const root = '/tmp/nr-evals-DRYRUN';
    const sandbox = { root, project: `${root}/project`, tmp: `${root}/tmp`, plugin: `${root}/plugin` };
    return { args: redactArgs(claudeArgs(run, ctx, sandbox)), repeat: ctx.runs };
  },

  // Sends the query ctx.runs times, each in a fresh sandbox, into ctx.outDir/run-<k>/. Query-level meta.json and timing.json
  // (summed over the repetitions) sit in ctx.outDir.
  async execute(run, ctx) {
    mkdirSync(ctx.outDir, { recursive: true });
    const startedAt = new Date().toISOString();
    const total = { total_tokens: 0, duration_ms: 0, total_cost_usd: 0, num_turns: 0 };
    for (let k = 1; k <= ctx.runs; k += 1) {
      const dir = join(ctx.outDir, `run-${k}`);
      mkdirSync(dir);
      const sandbox = createSandbox({ pluginName: run.config.plugin, skills: run.skills, familyDir: run.familyDir, files: run.config.triggerFiles ?? [], withSkill: true });
      try {
        const env = buildEnv(ctx.env, { unsetEnv: run.config.unsetEnv, tmpDir: sandbox.tmp });
        const args = claudeArgs(run, ctx, sandbox);
        const transcriptPath = join(dir, 'transcript.jsonl');
        const t0 = Date.now();
        const result = await runClaude({ args, cwd: sandbox.project, env, transcriptPath, stderrPath: join(dir, 'stderr.txt'), timeoutMs: ctx.timeoutMs });
        const wallMs = Date.now() - t0;
        writeJson(join(dir, 'meta.json'), {
          run: k,
          model: ctx.model ?? null,
          wallMs,
          paths: { sandbox: sandbox.root },
          args: redactArgs(args),
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          spawnError: result.spawnError,
        });
        const timing = timingFrom(parseTranscript(readFileSync(transcriptPath, 'utf8')), wallMs);
        writeJson(join(dir, 'timing.json'), timing);
        for (const key of Object.keys(total)) total[key] += timing[key];
      } finally {
        if (!ctx.keepTemp) rmSync(sandbox.root, { recursive: true, force: true });
      }
    }
    total.total_cost_usd = round(total.total_cost_usd);
    writeJson(join(ctx.outDir, 'timing.json'), total);
    writeJson(join(ctx.outDir, 'meta.json'), { kind: 'triggers', family: run.family, skill: run.skill, caseId: run.caseId, variant: run.variant, model: ctx.model ?? null, startedAt, query: run.query, should_trigger: run.shouldTrigger, runs: ctx.runs });
  },

  // Pure function of the saved repetitions and the current triggers.json. A should-trigger query passes at a trigger rate
  // above 0.5, a should-not-trigger query below 0.5; exactly 0.5 fails either way.
  grade(outDir, run) {
    const reps = repDirs(outDir).map(({ k, dir }) => {
      const parsed = parseTranscript(readFileSync(join(dir, 'transcript.jsonl'), 'utf8'));
      const error = repError(parsed, readJson(join(dir, 'meta.json')));
      const called = [...new Set(parsed.skillCalls.map(skillName))];
      const timingFile = join(dir, 'timing.json');
      const timing = existsSync(timingFile) ? readJson(timingFile) : { total_cost_usd: 0, total_tokens: 0 };
      return { run: k, error, skills_called: called, triggered: called.includes(run.skill), max_turns: isMaxTurns(parsed.result), cost_usd: timing.total_cost_usd, total_tokens: timing.total_tokens };
    });
    const valid = reps.filter((r) => !r.error);
    const triggered = valid.filter((r) => r.triggered).length;
    const rate = ratio(triggered, valid.length);
    const passed = rate !== null && (run.shouldTrigger ? rate > 0.5 : rate < 0.5);
    const errored = reps.filter((r) => r.error);
    return {
      kind: 'triggers',
      family: run.family,
      skill: run.skill,
      query_id: run.caseId,
      variant: run.variant,
      query: run.query,
      should_trigger: run.shouldTrigger,
      runs: reps.map(({ run: k, error, skills_called, triggered: t, max_turns }) => ({ run: k, triggered: t, skills_called, max_turns, error })),
      valid_runs: valid.length,
      triggered_runs: triggered,
      trigger_rate: rate,
      other_skills: [...new Set(valid.flatMap((r) => r.skills_called).filter((s) => s !== run.skill))].sort(),
      passed,
      cost_usd: round(reps.reduce((n, r) => n + r.cost_usd, 0)),
      total_tokens: reps.reduce((n, r) => n + r.total_tokens, 0),
      run: {
        error: !reps.length ? 'no saved repetitions' : errored.length ? `${errored.length} of ${reps.length} runs failed: ${errored[0].error}` : null,
      },
      summary: { PASS: passed ? 1 : 0, FAIL: passed ? 0 : 1, PARTIAL: 0, MANUAL: 0 },
    };
  },

  // One stderr line after the runner's own progress line.
  progress(grading) {
    const rate = grading.trigger_rate === null ? 'n/a' : `${grading.triggered_runs}/${grading.valid_runs}`;
    const other = grading.other_skills.length ? `; also called ${grading.other_skills.join(', ')}` : '';
    return `triggered ${rate} (expected ${grading.should_trigger ? 'trigger' : 'no trigger'}) ${grading.passed ? 'PASS' : 'FAIL'}${other}`;
  },

  // Per skill: accuracy, the confusion counts, precision and recall (null when the denominator is 0), spend, and every
  // query. A query with no valid repetition is counted in `queries` and `invalid` but not in the confusion counts.
  // `missed_to` (should-trigger queries that failed) and `confusion` (should-not-trigger queries) count, per other skill,
  // the queries on which that skill was called in at least one run.
  summarize(gradings) {
    const out = {};
    for (const g of gradings) {
      const s = (out[g.skill] ??= { queries: 0, correct: 0, accuracy: null, tp: 0, fp: 0, tn: 0, fn: 0, invalid: 0, precision: null, recall: null, confusion: {}, missed_to: {}, cost_usd: 0, total_tokens: 0, per_query: [] });
      s.queries += 1;
      if (g.passed) s.correct += 1;
      if (g.trigger_rate === null) s.invalid += 1;
      else if (g.should_trigger) s[g.passed ? 'tp' : 'fn'] += 1;
      else s[g.passed ? 'tn' : 'fp'] += 1;
      const into = g.should_trigger && !g.passed ? s.missed_to : !g.should_trigger ? s.confusion : null;
      if (into) for (const other of g.other_skills) into[other] = (into[other] ?? 0) + 1;
      s.cost_usd += g.cost_usd;
      s.total_tokens += g.total_tokens;
      s.per_query.push({ id: g.query_id, query: g.query, should_trigger: g.should_trigger, trigger_rate: g.trigger_rate, valid_runs: g.valid_runs, passed: g.passed, other_skills: g.other_skills });
    }
    for (const s of Object.values(out)) {
      s.accuracy = ratio(s.correct, s.queries);
      s.precision = ratio(s.tp, s.tp + s.fp);
      s.recall = ratio(s.tp, s.tp + s.fn);
      s.cost_usd = round(s.cost_usd);
      s.per_query.sort((a, b) => a.id - b.id);
    }
    return out;
  },
};
