// Eval kind "output": evals/<family>/<skill>/evals.json cases, each run through `claude -p` with the family's skills
// installed (with_skill) or not (without_skill, the baseline), then graded against the case's `checks`.
// Kind interface (see evals/README.md): discover, plan, outDir, execute, grade.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildClaudeArgs, buildEnv, caseEnvProblems, createSandbox, diffTrees, hashTree, parseTranscript, readApiKeyHelper, redactArgs, runClaude, runError, timingFrom } from '../claude.mjs';
import { gradeAssertions, validateChecks, validateGuards } from '../checks.mjs';

const VARIANTS = ['with_skill', 'without_skill'];
const FIXTURE = /^fixtures\/[^/]+\/(.+)$/;

function validateCase(evalCase, where, { familyDir, skillNames }) {
  const errors = [];
  if (!Number.isInteger(evalCase.id)) errors.push(`${where}: "id" must be an integer`);
  if (typeof evalCase.prompt !== 'string' || !evalCase.prompt) errors.push(`${where}: "prompt" must be a non-empty string`);
  if (!Array.isArray(evalCase.files)) errors.push(`${where}: "files" must be an array`);
  else {
    for (const f of evalCase.files) {
      if (!FIXTURE.test(f)) errors.push(`${where}: file "${f}" must look like fixtures/<case>/<path>`);
      else if (!existsSync(join(familyDir, f))) errors.push(`${where}: file "${f}" does not exist`);
    }
  }
  for (const e of caseEnvProblems(evalCase.env)) errors.push(`${where}: ${e}`);
  if (!Array.isArray(evalCase.assertions) || !evalCase.assertions.length || !evalCase.assertions.every((a) => typeof a === 'string')) {
    errors.push(`${where}: "assertions" must be a non-empty array of strings`);
    return errors;
  }
  for (const e of validateChecks(evalCase.checks, { assertionCount: evalCase.assertions.length, skillNames })) errors.push(`${where}: ${e}`);
  for (const e of validateGuards(evalCase.guards, { assertionCount: evalCase.assertions.length })) errors.push(`${where}: ${e}`);
  return errors;
}

export default {
  name: 'output',

  // Returns one run per (case, variant). Validates every evals.json it finds and throws one error listing all problems.
  discover({ family, familyDir, config, skills, root }) {
    const runs = [];
    const errors = [];
    const skillNames = skills.map((s) => s.name);
    for (const entry of readdirSync(familyDir, { withFileTypes: true })) {
      const file = join(familyDir, entry.name, 'evals.json');
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const where = `evals/${family}/${entry.name}/evals.json`;
      const skillDir = join(root, 'skills', family, entry.name);
      if (!existsSync(join(skillDir, 'SKILL.md'))) {
        errors.push(`${where}: skills/${family}/${entry.name}/SKILL.md does not exist`);
        continue;
      }
      let data;
      try {
        data = JSON.parse(readFileSync(file, 'utf8'));
      } catch (e) {
        errors.push(`${where}: ${e.message}`);
        continue;
      }
      if (data.skill_name !== entry.name) errors.push(`${where}: "skill_name" must be "${entry.name}"`);
      if (!Array.isArray(data.evals) || !data.evals.length) {
        errors.push(`${where}: "evals" must be a non-empty array`);
        continue;
      }
      const ids = new Set();
      data.evals.forEach((evalCase, i) => {
        const label = `${where} evals[${i}]`;
        if (ids.has(evalCase.id)) errors.push(`${label}: duplicate id ${evalCase.id}`);
        ids.add(evalCase.id);
        const caseErrors = validateCase(evalCase, label, { familyDir, skillNames });
        errors.push(...caseErrors);
        if (caseErrors.length) return;
        for (const variant of VARIANTS) {
          runs.push({ kind: 'output', family, skill: entry.name, caseId: evalCase.id, variant, case: evalCase, familyDir, config, skills, root, label: `${family}/${entry.name} eval-${evalCase.id} ${variant}` });
        }
      });
    }
    if (errors.length) throw new Error(errors.join('\n'));
    return runs;
  },

  outDir: (run) => join(run.skill, `eval-${run.caseId}`, run.variant),

  // Dry run: the redacted claude arguments for a fake sandbox path.
  plan(run, ctx) {
    const root = '/tmp/nr-evals-DRYRUN';
    const sandbox = { root, project: `${root}/project`, tmp: `${root}/tmp`, plugin: `${root}/plugin` };
    const args = buildClaudeArgs({ prompt: run.case.prompt, sandbox, bashAllow: run.config.bashAllow, withSkill: run.variant === 'with_skill', model: ctx.model, maxBudgetUsd: ctx.maxBudgetUsd, apiKeyHelper: readApiKeyHelper(ctx.env) });
    // Names only: a case's `env` values are never printed.
    return { args: redactArgs(args), envNames: Object.keys(run.case.env ?? {}) };
  },

  async execute(run, ctx) {
    const withSkill = run.variant === 'with_skill';
    const sandbox = createSandbox({ pluginName: run.config.plugin, skills: run.skills, familyDir: run.familyDir, files: run.case.files, withSkill });
    try {
      const pluginBefore = hashTree(sandbox.plugin);
      const env = buildEnv(ctx.env, { unsetEnv: run.config.unsetEnv, tmpDir: sandbox.tmp, caseEnv: run.case.env });
      const args = buildClaudeArgs({ prompt: run.case.prompt, sandbox, bashAllow: run.config.bashAllow, withSkill, model: ctx.model, maxBudgetUsd: ctx.maxBudgetUsd, apiKeyHelper: readApiKeyHelper(ctx.env) });
      mkdirSync(ctx.outDir, { recursive: true });
      const transcriptPath = join(ctx.outDir, 'transcript.jsonl');
      const startedAt = new Date().toISOString();
      const t0 = Date.now();
      const result = await runClaude({ args, cwd: sandbox.project, env, transcriptPath, stderrPath: join(ctx.outDir, 'stderr.txt'), timeoutMs: ctx.timeoutMs });
      const wallMs = Date.now() - t0;
      const { newFiles, changedFiles } = diffTrees(pluginBefore, hashTree(sandbox.plugin));
      cpSync(sandbox.project, join(ctx.outDir, 'project'), { recursive: true });
      cpSync(sandbox.tmp, join(ctx.outDir, 'tmp'), { recursive: true });
      const meta = {
        kind: 'output',
        family: run.family,
        skill: run.skill,
        caseId: run.caseId,
        variant: run.variant,
        model: ctx.model ?? null,
        startedAt,
        wallMs,
        paths: { sandbox: sandbox.root, project: sandbox.project, tmp: sandbox.tmp, plugin: sandbox.plugin },
        skillRel: sandbox.skillRel,
        args: redactArgs(args),
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        spawnError: result.spawnError,
        pluginNewFiles: newFiles,
        pluginChangedFiles: changedFiles,
      };
      writeFileSync(join(ctx.outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
      const parsed = parseTranscript(readFileSync(transcriptPath, 'utf8'));
      writeFileSync(join(ctx.outDir, 'timing.json'), `${JSON.stringify(timingFrom(parsed, wallMs), null, 2)}\n`);
    } finally {
      if (!ctx.keepTemp) rmSync(sandbox.root, { recursive: true, force: true });
    }
  },

  // Pure function of the saved artifacts and the current evals.json, so --regrade picks up edited checks.
  grade(outDir, run) {
    const meta = JSON.parse(readFileSync(join(outDir, 'meta.json'), 'utf8'));
    const parsed = parseTranscript(readFileSync(join(outDir, 'transcript.jsonl'), 'utf8'));
    const fixtureFor = (rel) => {
      for (const f of run.case.files) if (FIXTURE.exec(f)?.[1] === rel) return readFileSync(join(run.familyDir, f));
      return null;
    };
    const assertions = gradeAssertions(run.case, {
      runDir: outDir,
      projectDir: meta.paths.project,
      pluginDir: meta.paths.plugin,
      skillRel: meta.skillRel,
      variant: run.variant,
      commands: parsed.commands,
      final: parsed.final,
      pluginNewFiles: meta.pluginNewFiles,
      pluginChangedFiles: meta.pluginChangedFiles,
      fixtureFor,
    });
    // `summary` counts every assertion (it drives the exit code); guards are also counted apart from the scored ones.
    const count = (list) => list.reduce((n, a) => ({ ...n, [a.result]: n[a.result] + 1 }), { PASS: 0, FAIL: 0, PARTIAL: 0, MANUAL: 0 });
    const summary = count(assertions);
    const guard_summary = count(assertions.filter((a) => a.guard));
    const scored_summary = count(assertions.filter((a) => !a.guard));
    return {
      kind: 'output',
      family: run.family,
      skill: run.skill,
      eval_id: run.caseId,
      variant: run.variant,
      skill_invoked: parsed.skillCalls,
      run: {
        error: runError(parsed, meta),
        is_error: parsed.result?.is_error ?? null,
        terminal_reason: parsed.result?.terminal_reason ?? null,
        exit_code: meta.exitCode,
        timed_out: meta.timedOut,
      },
      permission_denials: parsed.permissionDenials,
      summary,
      guard_summary,
      scored_summary,
      assertions,
      final_response: parsed.final,
    };
  },
};
