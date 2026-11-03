#!/usr/bin/env node
// Dev-only runner for agent-level evals (evals/<family>/). Each case runs headlessly through `claude -p` in a throwaway
// sandbox with the family's skills installed, and every assertion that has a mechanical check is graded; the rest are
// marked MANUAL. Spends Claude API credit; not part of `npm test` or CI. Details: evals/README.md.
// Usage: node tools/run-evals.mjs [--family <f>] [--skill <name>] [--case <id>] [--baseline] [--dry-run] [--regrade <N>] ...
//        (--help lists every flag; exits 1 on a FAIL or a failed run, 2 on a usage or setup error)

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bashRuleProblem } from './evals/claude.mjs';
import output from './evals/kinds/output.mjs';
import triggers from './evals/kinds/triggers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_KEYS = ['plugin', 'install', 'unsetEnv', 'bashAllow', 'triggerFiles'];

// Add new eval kinds here (see evals/README.md, "Adding an eval kind").
export const KINDS = [output, triggers];

export class UsageError extends Error {}

const USAGE = `Usage: node tools/run-evals.mjs [options]

Runs the agent-level evals under evals/<family>/ through headless \`claude -p\`. Spends API credit.

  --family <f>          only this family (repeatable; default: all)
  --kind <k>            only this eval kind (repeatable; default: all; kinds: ${KINDS.map((k) => k.name).join(', ')})
  --skill <name>        only this skill's evals (repeatable)
  --case <id>           only this case id (repeatable; needs exactly one --skill)
  --baseline            also run every case without the skills installed (without_skill)
  --runs <n>            times each trigger query is sent (triggers kind; default 3)
  --model <m>           model passed to claude
  --max-budget-usd <n>  spend cap per run (default 2)
  --timeout <s>         wall-clock cap per run in seconds (default 600)
  --iteration <N>       iteration number (single family only; default: next unused)
  --keep-temp           keep each run's sandbox directory
  --dry-run             list the planned runs and claude arguments; run nothing, write nothing
  --regrade <N>         re-grade saved iteration N from its artifacts with the current checks; no claude calls
  -h, --help            show this help

Results: evals/workspace/<family>/iteration-<N>/. JSON summary on stdout, progress on stderr.
`;

const OPTIONS = {
  family: { type: 'string', multiple: true },
  kind: { type: 'string', multiple: true },
  skill: { type: 'string', multiple: true },
  case: { type: 'string', multiple: true },
  baseline: { type: 'boolean' },
  runs: { type: 'string' },
  model: { type: 'string' },
  'max-budget-usd': { type: 'string' },
  timeout: { type: 'string' },
  iteration: { type: 'string' },
  'keep-temp': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  regrade: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

function number(flag, value, { integer = false, min = 0 } = {}) {
  const n = Number(value);
  if (value === '' || !Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) throw new UsageError(`${flag} must be ${integer ? 'an integer' : 'a number'} >= ${min}, got "${value}"`);
  return n;
}

export function parseCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: false, strict: true }));
  } catch (e) {
    throw new UsageError(e.message);
  }
  const opts = {
    help: !!values.help,
    families: values.family ?? [],
    kinds: values.kind ?? [],
    skills: values.skill ?? [],
    cases: (values.case ?? []).map((c) => number('--case', c, { integer: true })),
    baseline: !!values.baseline,
    runs: values.runs === undefined ? 3 : number('--runs', values.runs, { integer: true, min: 1 }),
    model: values.model,
    maxBudgetUsd: values['max-budget-usd'] === undefined ? 2 : number('--max-budget-usd', values['max-budget-usd'], { min: 0.01 }),
    timeoutS: values.timeout === undefined ? 600 : number('--timeout', values.timeout, { min: 1 }),
    iteration: values.iteration === undefined ? null : number('--iteration', values.iteration, { integer: true, min: 1 }),
    keepTemp: !!values['keep-temp'],
    dryRun: !!values['dry-run'],
    regrade: values.regrade === undefined ? null : number('--regrade', values.regrade, { integer: true, min: 1 }),
  };
  if (opts.cases.length && opts.skills.length !== 1) throw new UsageError('--case needs exactly one --skill');
  if (opts.regrade !== null && (opts.dryRun || opts.iteration !== null)) throw new UsageError('--regrade cannot be combined with --dry-run or --iteration');
  return opts;
}

// Skills the family's sandbox plugin installs: every skills/<family>/<skill>/ (with a SKILL.md) for each `install` family.
export function listInstallSkills(rootDir, install) {
  const skills = [];
  for (const family of install) {
    const dir = join(rootDir, 'skills', family);
    if (!existsSync(dir)) throw new Error(`install family "${family}": skills/${family}/ does not exist`);
    const found = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md')))
      .map((e) => ({ family, name: e.name, dir: join(dir, e.name) }));
    if (!found.length) throw new Error(`install family "${family}": skills/${family}/ has no skill folders with a SKILL.md`);
    skills.push(...found);
  }
  const seen = new Set();
  for (const s of skills) {
    if (seen.has(s.name)) throw new Error(`skill name "${s.name}" appears twice in "install"`);
    seen.add(s.name);
  }
  return skills;
}

// Validates evals/<family>/config.json. Returns the normalized config plus its install skills; throws one error listing every problem.
export function loadFamilyConfig(rootDir, family) {
  const where = `evals/${family}/config.json`;
  const file = join(rootDir, 'evals', family, 'config.json');
  if (!existsSync(file)) throw new UsageError(`${where} is missing: every directory under evals/ except workspace/ is a family and needs one (see evals/README.md)`);
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UsageError(`${where}: ${e.message}`);
  }
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new UsageError(`${where}: must be a JSON object`);
  for (const key of Object.keys(config)) if (!CONFIG_KEYS.includes(key)) errors.push(`unknown key "${key}"`);
  const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s);
  const marketplace = JSON.parse(readFileSync(join(rootDir, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const plugins = (marketplace.plugins ?? []).map((p) => p.name);
  if (typeof config.plugin !== 'string' || !config.plugin) errors.push('"plugin" must be a non-empty string');
  else if (!plugins.includes(config.plugin)) errors.push(`"plugin" ${config.plugin} is not a plugin in .claude-plugin/marketplace.json (${plugins.join(', ')})`);
  if (!strings(config.install) || !config.install.length) errors.push('"install" must be a non-empty array of skill family names');
  if (config.unsetEnv !== undefined && !(strings(config.unsetEnv) && config.unsetEnv.every((u) => /^[A-Za-z0-9_]+\*?$/.test(u)))) errors.push('"unsetEnv" must be an array of variable names (a trailing * matches a prefix)');
  if (config.bashAllow !== undefined && !(strings(config.bashAllow) && config.bashAllow.every((b) => !/[()]/.test(b)))) errors.push('"bashAllow" must be an array of Bash rule bodies without parentheses, e.g. "node {plugin}/skills/<family>/<skill>/scripts/<skill>.mjs *"');
  else for (const b of config.bashAllow ?? []) {
    const problem = bashRuleProblem(b);
    if (problem) errors.push(`"bashAllow" entry ${problem}`);
  }
  if (config.triggerFiles !== undefined && !(strings(config.triggerFiles) && config.triggerFiles.every((f) => /^fixtures\/[^/]+\/.+$/.test(f) && !f.split('/').includes('..') && existsSync(join(rootDir, 'evals', family, f))))) errors.push('"triggerFiles" must be an array of existing fixtures/<case>/<path> files under the family folder');
  let skills = [];
  if (!errors.length) {
    try {
      skills = listInstallSkills(rootDir, config.install);
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (errors.length) throw new UsageError(`${where}:\n  ${errors.join('\n  ')}`);
  return { config: { plugin: config.plugin, install: config.install, unsetEnv: config.unsetEnv ?? [], bashAllow: config.bashAllow ?? [], triggerFiles: config.triggerFiles ?? [] }, skills };
}

export function listFamilies(rootDir) {
  const dir = join(rootDir, 'evals');
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'workspace')
    .map((e) => e.name)
    .sort();
}

// Every run (all kinds, all variants) for the selected families. Validates all eval data, so a typo anywhere is caught before any spawn.
export function discoverRuns(rootDir, { families = [], kinds = [] } = {}) {
  const all = listFamilies(rootDir);
  for (const f of families) if (!all.includes(f)) throw new UsageError(`unknown family "${f}" (have: ${all.join(', ') || 'none'})`);
  for (const k of kinds) if (!KINDS.some((kind) => kind.name === k)) throw new UsageError(`unknown kind "${k}" (have: ${KINDS.map((kind) => kind.name).join(', ')})`);
  const runs = [];
  const problems = [];
  for (const family of families.length ? families : all) {
    const { config, skills } = loadFamilyConfig(rootDir, family);
    for (const kind of KINDS.filter((k) => !kinds.length || kinds.includes(k.name))) {
      try {
        runs.push(...kind.discover({ family, familyDir: join(rootDir, 'evals', family), config, skills, root: rootDir }));
      } catch (e) {
        problems.push(e.message);
      }
    }
  }
  if (problems.length) throw new UsageError(problems.join('\n'));
  return runs;
}

export function filterRuns(runs, { skills = [], cases = [], baseline = false }) {
  for (const s of skills) if (!runs.some((r) => r.skill === s)) throw new UsageError(`unknown skill "${s}" (have: ${[...new Set(runs.map((r) => r.skill))].join(', ')})`);
  for (const c of cases) if (!runs.some((r) => r.skill === skills[0] && r.caseId === c)) throw new UsageError(`${skills[0]} has no case with id ${c}`);
  return runs.filter((r) => (baseline || r.variant === 'with_skill') && (!skills.length || skills.includes(r.skill)) && (!cases.length || cases.includes(r.caseId)));
}

export function nextIteration(rootDir, family) {
  const dir = join(rootDir, 'evals', 'workspace', family);
  if (!existsSync(dir)) return 1;
  const nums = readdirSync(dir).map((n) => /^iteration-(\d+)$/.exec(n)?.[1]).filter(Boolean).map(Number);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

const iterationDir = (rootDir, family, n) => join(rootDir, 'evals', 'workspace', family, `iteration-${n}`);
const kindOf = (run) => KINDS.find((k) => k.name === run.kind);
const writeJson = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
const short = (s) => (s.length > 120 ? `${s.slice(0, 117)}...` : s);

function describeRun(run, ctx) {
  const { args, repeat, envNames = [] } = kindOf(run).plan(run, ctx);
  const envLine = envNames.length ? `\n  env (from the case, values not shown): ${envNames.join(', ')}` : '';
  return `${run.label}${repeat > 1 ? ` (x${repeat} runs)` : ''}${envLine}\n  claude ${args.map((a, i) => JSON.stringify(i === 1 ? short(a) : a)).join(' ')}`;
}

export async function main(argv = process.argv.slice(2), env = process.env, rootDir = root, io = { out: process.stdout, err: process.stderr }) {
  try {
    const opts = parseCli(argv);
    if (opts.help) {
      io.out.write(USAGE);
      return 0;
    }
    const all = discoverRuns(rootDir, opts);
    // A regrade covers whatever variants were saved, baseline included.
    let runs = filterRuns(all, { ...opts, baseline: opts.baseline || opts.regrade !== null });
    if (!runs.length) throw new UsageError('no runs selected');
    const familiesUsed = [...new Set(runs.map((r) => r.family))];
    if (opts.iteration !== null && familiesUsed.length !== 1) throw new UsageError('--iteration needs exactly one family (use --family)');

    const iterations = Object.fromEntries(familiesUsed.map((f) => [f, opts.regrade ?? opts.iteration ?? nextIteration(rootDir, f)]));
    const outDirOf = (run) => join(iterationDir(rootDir, run.family, iterations[run.family]), kindOf(run).outDir(run));
    const ctxBase = { root: rootDir, env, model: opts.model, maxBudgetUsd: opts.maxBudgetUsd, runs: opts.runs, timeoutMs: opts.timeoutS * 1000, keepTemp: opts.keepTemp };

    if (opts.dryRun) {
      io.out.write(`${runs.map((r) => describeRun(r, ctxBase)).join('\n')}\n`);
      io.err.write(`dry run: ${runs.length} runs planned, nothing executed\n`);
      return 0;
    }
    if (opts.regrade !== null) {
      runs = runs.filter((r) => existsSync(join(outDirOf(r), 'meta.json')));
      if (!runs.length) throw new UsageError(`iteration ${opts.regrade} has no saved runs for this selection`);
    } else {
      const probe = spawnSync('claude', ['--version'], { stdio: 'ignore' });
      if (probe.error) throw new UsageError(`cannot run claude: ${probe.error.code ?? probe.error.message}. Install Claude Code and make sure \`claude\` is on PATH.`);
      const taken = runs.filter((r) => existsSync(outDirOf(r)));
      if (taken.length) throw new UsageError(`output already exists, nothing is overwritten (use --iteration or remove it): ${taken.map((r) => relative(rootDir, outDirOf(r))).join(', ')}`);
    }

    const records = [];
    const gradings = new Map();
    for (const [i, run] of runs.entries()) {
      const outDir = outDirOf(run);
      const record = { family: run.family, kind: run.kind, skill: run.skill, id: run.caseId, variant: run.variant, dir: relative(rootDir, outDir), summary: null, guard: null, scored: null, error: null, cost_usd: 0, duration_ms: 0 };
      try {
        if (opts.regrade === null) await kindOf(run).execute(run, { ...ctxBase, outDir });
        const grading = kindOf(run).grade(outDir, run, ctxBase);
        writeJson(join(outDir, 'grading.json'), grading);
        gradings.set(record, grading);
        record.summary = grading.summary;
        record.guard = grading.guard_summary ?? null;
        record.scored = grading.scored_summary ?? null;
        record.error = grading.run.error;
        const timingFile = join(outDir, 'timing.json');
        if (existsSync(timingFile)) {
          const timing = JSON.parse(readFileSync(timingFile, 'utf8'));
          record.cost_usd = timing.total_cost_usd;
          record.duration_ms = timing.duration_ms;
        }
      } catch (e) {
        record.error = `runner error: ${e.message}`;
      }
      records.push(record);
      const s = record.summary;
      const counts = s ? `${s.PASS} PASS ${s.FAIL} FAIL ${s.PARTIAL} PARTIAL ${s.MANUAL} MANUAL` : 'not graded';
      io.err.write(`[${i + 1}/${runs.length}] ${run.label}: ${counts} ($${record.cost_usd.toFixed(2)}, ${Math.round(record.duration_ms / 1000)}s)${record.error ? ` ERROR: ${record.error}` : ''}\n`);
      const extra = gradings.has(record) && kindOf(run).progress?.(gradings.get(record));
      if (extra) io.err.write(`    ${extra}\n`);
    }

    const sumOf = (list, key) => Object.fromEntries(['PASS', 'FAIL', 'PARTIAL', 'MANUAL'].map((k) => [k, list.reduce((n, r) => n + (r[key]?.[k] ?? 0), 0)]));
    const totalsOf = (list) => ({
      runs: list.length,
      errors: list.filter((r) => r.error).length,
      PASS: list.reduce((n, r) => n + (r.summary?.PASS ?? 0), 0),
      FAIL: list.reduce((n, r) => n + (r.summary?.FAIL ?? 0), 0),
      PARTIAL: list.reduce((n, r) => n + (r.summary?.PARTIAL ?? 0), 0),
      MANUAL: list.reduce((n, r) => n + (r.summary?.MANUAL ?? 0), 0),
      scored: sumOf(list, 'scored'),
      guard: sumOf(list, 'guard'),
      cost_usd: Number(list.reduce((n, r) => n + r.cost_usd, 0).toFixed(4)),
    });
    const summary = { generatedAt: new Date().toISOString(), families: {}, totals: totalsOf(records) };
    for (const family of familiesUsed) {
      const mine = records.filter((r) => r.family === family);
      const entry = { iteration: iterations[family], runs: mine, totals: totalsOf(mine) };
      // Kinds with a summarize hook add a roll-up of their graded runs under `kinds.<name>`.
      for (const kind of KINDS.filter((k) => k.summarize)) {
        const graded = mine.filter((r) => r.kind === kind.name && gradings.has(r)).map((r) => gradings.get(r));
        if (graded.length) (entry.kinds ??= {})[kind.name] = kind.summarize(graded);
      }
      summary.families[family] = entry;
      mkdirSync(iterationDir(rootDir, family, iterations[family]), { recursive: true });
      writeJson(join(iterationDir(rootDir, family, iterations[family]), 'summary.json'), { family, generatedAt: summary.generatedAt, ...entry });
    }
    io.out.write(`${JSON.stringify(summary, null, 2)}\n`);
    // A baseline (without_skill) run is expected to fail checks about the skill; only its run errors count.
    const bad = records.some((r) => r.error || (r.variant === 'with_skill' && r.summary?.FAIL > 0));
    return bad ? 1 : 0;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err.write(`run-evals: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main();
