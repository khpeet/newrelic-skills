#!/usr/bin/env node
// Dev-only report generator: turns saved eval iterations (evals/workspace/<family>/iteration-<N>/) into a short
// evals/<family>/<skill>/eval_results.md per skill. Reads summary.json, grading.json, meta.json and timing.json; spends
// nothing. Details: evals/README.md, "Reports".
// Usage: node tools/evals/report.mjs --family <f> --iterations 3,4,5 [--triggers <N>]

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_FAILING = 15;
const TEXT_CHARS = 90;
const EVIDENCE_CHARS = 120;
const OPEN_ITEMS = '- _To fill in by hand after reading the above (at most 5 bullets)._';

export class UsageError extends Error {}

const USAGE = `Usage: node tools/evals/report.mjs --family <f> --iterations <N[,N...]> [--triggers <N>]

Writes evals/<family>/<skill>/eval_results.md (about 30 lines each) from saved iterations in evals/workspace/<family>/.
No claude calls; spends nothing.

  --family <f>         family under evals/ (required)
  --iterations <list>  comma-separated iteration numbers holding output runs, e.g. 3,4,5,6,7,8 (required)
  --triggers <N>       iteration holding the trigger runs (default: the last listed iteration that has any)
  -h, --help           show this help
`;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const readJsonIf = (file) => (existsSync(file) ? readJson(file) : null);
const clip = (s, n) => {
  const text = String(s).replace(/\s+/g, ' ').trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};
const shortModel = (m) => (m ? m.replace(/^claude-/, '') : 'default model');
const pct = (n, d) => (d ? `${(Math.round((n / d) * 1000) / 10).toFixed(1)}%` : 'n/a');
const money = (n) => `$${n.toFixed(2)}`;
const tokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
const zero = () => ({ PASS: 0, FAIL: 0, PARTIAL: 0 });

// Loads every output run of the listed iterations: {skill, id, variant, model, iteration, assertions, cost, tokens}.
function loadRuns(rootDir, family, iterations) {
  const runs = [];
  const generated = [];
  for (const n of iterations) {
    const dir = join(rootDir, 'evals', 'workspace', family, `iteration-${n}`);
    const summary = readJsonIf(join(dir, 'summary.json'));
    if (!summary) throw new UsageError(`iteration ${n}: ${join('evals', 'workspace', family, `iteration-${n}`, 'summary.json')} not found`);
    generated.push(summary.generatedAt);
    for (const rec of summary.runs) {
      if (rec.kind !== 'output') continue;
      const runDir = join(rootDir, rec.dir);
      const grading = readJsonIf(join(runDir, 'grading.json'));
      if (!grading) continue;
      const meta = readJsonIf(join(runDir, 'meta.json')) ?? {};
      const timing = readJsonIf(join(runDir, 'timing.json')) ?? {};
      runs.push({ iteration: n, skill: rec.skill, id: rec.id, variant: rec.variant, model: meta.model ?? null, assertions: grading.assertions, error: grading.run?.error ?? null, cost: timing.total_cost_usd ?? rec.cost_usd ?? 0, tokens: timing.total_tokens ?? 0 });
    }
  }
  return { runs, generated };
}

// Trigger roll-up for one skill from the chosen iteration, or null.
function loadTriggers(rootDir, family, iterations, explicit) {
  const candidates = explicit === null ? [...iterations].reverse() : [explicit];
  for (const n of candidates) {
    const dir = join(rootDir, 'evals', 'workspace', family, `iteration-${n}`);
    const summary = readJsonIf(join(dir, 'summary.json'));
    if (!summary) {
      if (explicit !== null) throw new UsageError(`iteration ${n}: summary.json not found`);
      continue;
    }
    if (summary.kinds?.triggers) return { iteration: n, dir, bySkill: summary.kinds.triggers, generatedAt: summary.generatedAt };
    if (explicit !== null) throw new UsageError(`iteration ${n} has no trigger results`);
  }
  return null;
}

function rate(runs, variant) {
  const t = zero();
  for (const r of runs.filter((x) => x.variant === variant)) for (const a of r.assertions) if (!a.guard && t[a.result] !== undefined) t[a.result] += 1;
  return { ...t, total: t.PASS + t.FAIL + t.PARTIAL };
}

function guardRate(runs, variant) {
  const t = { PASS: 0, total: 0 };
  for (const r of runs.filter((x) => x.variant === variant)) {
    for (const a of r.assertions) {
      if (!a.guard || a.result === 'MANUAL') continue;
      t.total += 1;
      if (a.result === 'PASS') t.PASS += 1;
    }
  }
  return t;
}

const cell = (t) => (t.total ? `${t.PASS}/${t.total} (${pct(t.PASS, t.total)})${t.PARTIAL ? `, ${t.PARTIAL} partial` : ''}` : 'n/a');
const delta = (a, b) => (a.total && b.total ? `${a.PASS / a.total >= b.PASS / b.total ? '+' : ''}${(Math.round((a.PASS / a.total - b.PASS / b.total) * 1000) / 10).toFixed(1)} pts` : 'n/a');

function passTable(runs, models) {
  const lines = ['| Model | Trials | With skill | Baseline | Delta |', '|---|---|---|---|---|'];
  const guards = [];
  for (const model of models) {
    const mine = runs.filter((r) => r.model === model);
    const trials = new Set(mine.map((r) => r.iteration)).size;
    const w = rate(mine, 'with_skill');
    const b = rate(mine, 'without_skill');
    lines.push(`| ${shortModel(model)} | ${trials} | ${cell(w)} | ${cell(b)} | ${delta(w, b)} |`);
    const gw = guardRate(mine, 'with_skill');
    const gb = guardRate(mine, 'without_skill');
    if (gw.total || gb.total) guards.push(`${shortModel(model)} ${gw.PASS}/${gw.total} with skill, ${gb.PASS}/${gb.total} baseline`);
  }
  lines.push('');
  lines.push(guards.length ? `Guards (non-discriminating, excluded from the rates and delta): ${guards.join('; ')}.` : 'Guards (non-discriminating, excluded from the rates and delta): none.');
  return lines;
}

function routingLine(triggers, skill, rootDir) {
  if (!triggers) return 'Routing: not measured in these iterations.';
  const t = triggers.bySkill[skill];
  if (!t) return `Routing: no trigger queries for this skill in iteration ${triggers.iteration}.`;
  const meta = readJsonIf(join(triggers.dir, 'triggers', skill, 'q-1', 'meta.json')) ?? {};
  const misses = t.per_query.filter((q) => !q.passed).map((q) => `q${q.id} (${q.should_trigger ? 'should trigger' : 'should not'}, rate ${q.trigger_rate ?? 'n/a'})`);
  const flaky = t.per_query.filter((q) => q.passed && q.trigger_rate !== null && q.trigger_rate > 0 && q.trigger_rate < 1).map((q) => `q${q.id}`);
  const other = Object.entries(t.confusion ?? {}).map(([s, n]) => `${s} ${n}`);
  return `Routing (${shortModel(meta.model)}, ${meta.runs ?? '?'} runs/query, iteration ${triggers.iteration}): ${t.correct}/${t.queries} correct (${pct(t.correct, t.queries)}); misses: ${misses.join(', ') || 'none'}; flaky: ${flaky.join(', ') || 'none'}${other.length ? `; confused with: ${other.join(', ')}` : ''}.`;
}

function costLine(runs, models) {
  const parts = models.map((model) => {
    const avg = (variant) => {
      const mine = runs.filter((r) => r.model === model && r.variant === variant);
      return mine.length ? { cost: mine.reduce((n, r) => n + r.cost, 0) / mine.length, tokens: mine.reduce((n, r) => n + r.tokens, 0) / mine.length } : null;
    };
    const w = avg('with_skill');
    const b = avg('without_skill');
    if (!w) return null;
    const base = b ? `${money(b.cost)}/${tokens(b.tokens)} baseline, delta ${w.cost - b.cost >= 0 ? '+' : '-'}${money(Math.abs(w.cost - b.cost))}` : 'no baseline';
    return `${shortModel(model)} ${money(w.cost)}/${tokens(w.tokens)} tokens with skill, ${base}`;
  });
  return `Cost per run (average): ${parts.filter(Boolean).join('; ') || 'n/a'}.`;
}

// Assertions that are FAIL or PARTIAL in at least one with-skill run, grouped by eval id and assertion index.
function failingLines(runs) {
  const groups = new Map();
  for (const r of runs.filter((x) => x.variant === 'with_skill')) {
    for (const a of r.assertions) {
      const key = `${r.id}/${a.index}`;
      const g = groups.get(key) ?? { id: r.id, index: a.index, text: a.text, guard: !!a.guard, runs: 0, FAIL: 0, PARTIAL: 0, evidence: null };
      g.runs += 1;
      if (a.result === 'FAIL' || a.result === 'PARTIAL') {
        g[a.result] += 1;
        const ev = a.evidence?.find((e) => !e.pass) ?? a.evidence?.[0];
        if (!g.evidence && ev) g.evidence = ev.evidence;
      }
      groups.set(key, g);
    }
  }
  const bad = [...groups.values()].filter((g) => g.FAIL || g.PARTIAL).sort((a, b) => a.id - b.id || a.index - b.index);
  const manual = new Set(runs.filter((r) => r.variant === 'with_skill').flatMap((r) => r.assertions.filter((a) => a.result === 'MANUAL').map((a) => `${r.id}/${a.index}`))).size;
  const lines = bad.slice(0, MAX_FAILING).map((g) => {
    const counts = [g.FAIL && `${g.FAIL} fail`, g.PARTIAL && `${g.PARTIAL} partial`].filter(Boolean).join(', ');
    return `- e${g.id}/a${g.index}${g.guard ? ' (guard)' : ''}: ${clip(g.text, TEXT_CHARS)} [${counts} of ${g.runs}]${g.evidence ? ` - ${clip(g.evidence, EVIDENCE_CHARS)}` : ''}`;
  });
  if (bad.length > MAX_FAILING) lines.push(`- ... and ${bad.length - MAX_FAILING} more`);
  if (!bad.length) lines.push('- None: every graded with-skill assertion passed in every run.');
  if (manual) lines.push(`- ${manual} manual assertion(s) not listed.`);
  return lines;
}

export function renderSkill({ skill, runs, triggers, iterations, date, rootDir }) {
  const mine = runs.filter((r) => r.skill === skill);
  const models = [...new Set(mine.map((r) => r.model))].sort((a, b) => String(a).localeCompare(String(b)));
  const trials = Math.max(0, ...models.map((m) => new Set(mine.filter((r) => r.model === m).map((r) => r.iteration)).size));
  return [
    `# ${skill} eval results`,
    '',
    `Generated ${date}. Models: ${models.map(shortModel).join(', ') || 'n/a'}. Trials: ${trials} per model.`,
    '',
    ...(mine.length ? passTable(mine, models) : ['No output runs for this skill in the listed iterations.']),
    '',
    routingLine(triggers, skill, rootDir),
    costLine(mine, models),
    '',
    '## Failing / partial (with skill)',
    ...failingLines(mine),
    '',
    '## Open items',
    OPEN_ITEMS,
    '',
  ].join('\n');
}

const listOf = (flag, value) => {
  const nums = value.split(',').map((s) => s.trim());
  if (!nums.length || nums.some((s) => !/^[1-9]\d*$/.test(s))) throw new UsageError(`${flag} must be a comma-separated list of positive integers, got "${value}"`);
  return [...new Set(nums.map(Number))].sort((a, b) => a - b);
};

export function main(argv = process.argv.slice(2), rootDir = root, io = { out: process.stdout, err: process.stderr }) {
  try {
    let values;
    try {
      ({ values } = parseArgs({ args: argv, options: { family: { type: 'string' }, iterations: { type: 'string' }, triggers: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false, strict: true }));
    } catch (e) {
      throw new UsageError(e.message);
    }
    if (values.help) {
      io.out.write(USAGE);
      return 0;
    }
    if (!values.family || !values.iterations) throw new UsageError('--family and --iterations are required');
    if (!/^[A-Za-z0-9_-]+$/.test(values.family) || !existsSync(join(rootDir, 'evals', values.family))) throw new UsageError(`unknown family "${values.family}"`);
    const iterations = listOf('--iterations', values.iterations);
    const explicit = values.triggers === undefined ? null : listOf('--triggers', values.triggers)[0];
    const { runs, generated } = loadRuns(rootDir, values.family, iterations);
    const triggers = loadTriggers(rootDir, values.family, iterations, explicit);
    const skills = [...new Set([...runs.map((r) => r.skill), ...Object.keys(triggers?.bySkill ?? {})])].sort();
    if (!skills.length) throw new UsageError('no graded runs found in the listed iterations');
    const date = [...generated, triggers?.generatedAt].filter(Boolean).sort().at(-1).slice(0, 10);
    for (const skill of skills) {
      const dir = join(rootDir, 'evals', values.family, skill);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'eval_results.md');
      writeFileSync(file, renderSkill({ skill, runs, triggers, iterations, date, rootDir }));
      io.out.write(`${file.slice(rootDir.length + 1)}\n`);
    }
    return 0;
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err.write(`report: ${e.message}\n`);
    return 2;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main();
