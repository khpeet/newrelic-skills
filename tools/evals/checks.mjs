// Mechanical checks for agent-level evals. An eval case lists `checks` next to its plain-English `assertions`; each
// check points at one assertion by index and is run against the saved artifacts of one claude run. Assertions without
// a check are graded MANUAL. See evals/README.md for the schema; to add a check type, add one entry to CHECKS.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { parseYaml } from '../../shared/workflow-automation/yaml.mjs';
import { validateLocal } from '../../shared/workflow-automation/validation.mjs';

const MAX_EVIDENCE = 300;
const MAX_SCAN_BYTES = 5 * 1024 * 1024;
const COMMON_KEYS = new Set(['assertion', 'type', 'partial', 'when_exists']);
// Outputs every action step has, so they need no selector (see the build-workflow SKILL.md).
const BUILTIN_OUTPUTS = new Set(['success', 'errorMessage']);
const STEP_REF = /\.steps\.([A-Za-z0-9_]+)\.outputs\.([A-Za-z0-9_]+)/g;
const TOKEN = /\{(projectDir|pluginDir|skillDir:([A-Za-z0-9._-]+))\}/g;
const YAML_OPS = ['equals', 'matches', 'length', 'minLength', 'keys'];

const clip = (s) => {
  const text = String(s).replace(/\s+/g, ' ').trim();
  return text.length > MAX_EVIDENCE ? `${text.slice(0, MAX_EVIDENCE)}…` : text;
};
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// macOS reports temp dirs as /private/var/...; the agent may print either spelling.
const escapePath = (p) => (p.startsWith('/private/') ? `(?:/private)?${escapeRegex(p.slice('/private'.length))}` : escapeRegex(p));

// Replaces {projectDir}, {pluginDir}, and {skillDir:<name>} with regex-escaped absolute paths. Unknown skill names throw.
export function expandPattern(pattern, ctx) {
  return pattern.replace(TOKEN, (_, token, skill) => {
    if (token === 'projectDir') return escapePath(ctx.projectDir);
    if (token === 'pluginDir') return escapePath(ctx.pluginDir);
    const rel = ctx.skillRel[skill];
    if (!rel) throw new Error(`unknown skill in {skillDir:${skill}}`);
    return escapePath(join(ctx.pluginDir, rel));
  });
}

const regexOf = (pattern, flags, ctx) => new RegExp(expandPattern(pattern, ctx), flags ?? '');

// Walks `at` ("steps.0.inputs.*.name") through `value`. Numeric segments index arrays, `*` fans out over array elements
// or object values. Returns every value reached; empty means the path does not exist.
export function resolveYamlPath(value, at) {
  let current = [value];
  for (const segment of at.split('.')) {
    const next = [];
    for (const item of current) {
      if (item === null || typeof item !== 'object') continue;
      if (segment === '*') next.push(...(Array.isArray(item) ? item : Object.values(item)));
      else if (Array.isArray(item)) {
        if (/^\d+$/.test(segment) && Number(segment) < item.length) next.push(item[Number(segment)]);
      } else if (Object.hasOwn(item, segment)) next.push(item[segment]);
    }
    current = next;
  }
  return current;
}

const isScalar = (v) => ['string', 'number', 'boolean'].includes(typeof v);
const sizeOf = (v) => (Array.isArray(v) || typeof v === 'string' ? v.length : v && typeof v === 'object' ? Object.keys(v).length : null);

function yamlOpResult(check, values, ctx) {
  if ('equals' in check) return values.some((v) => isDeepStrictEqual(v, check.equals));
  if ('matches' in check) {
    const re = regexOf(check.matches, check.flags, ctx);
    return values.some((v) => isScalar(v) && re.test(String(v)));
  }
  if ('length' in check) return values.some((v) => sizeOf(v) === check.length);
  if ('minLength' in check) return values.some((v) => (sizeOf(v) ?? -1) >= check.minLength);
  const want = [...check.keys].sort();
  return values.some((v) => v && typeof v === 'object' && !Array.isArray(v) && isDeepStrictEqual(Object.keys(v).sort(), want));
}

const projectFile = (ctx, path) => join(ctx.runDir, 'project', path);
const readProject = (ctx, path) => {
  const file = projectFile(ctx, path);
  return existsSync(file) && statSync(file).isFile() ? readFileSync(file) : null;
};

function parseProjectYaml(ctx, path) {
  const buf = readProject(ctx, path);
  if (!buf) return { error: `${path} does not exist` };
  try {
    const docs = parseYaml(buf.toString('utf8'));
    return { doc: docs[0] };
  } catch (e) {
    return { error: `${path} does not parse: ${e.message.split('\n')[0]}` };
  }
}

function walkFiles(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else if (entry.isFile()) out.push(full.slice(base.length + 1));
  }
  return out;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Steps in document order, loop bodies (for.steps) included right after their loop.
function flattenSteps(steps, out = []) {
  if (!Array.isArray(steps)) return out;
  for (const step of steps) {
    if (!isObj(step)) continue;
    out.push(step);
    if (step.type === 'loop' && isObj(step.for)) flattenSteps(step.for.steps, out);
  }
  return out;
}

// Every string under `value`, not descending into a loop's nested steps (those are flattened separately).
function stringsOf(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) if (!(k === 'for' && isObj(v) && 'steps' in v)) stringsOf(v, out);
  return out;
}

const pass = (evidence) => ({ pass: true, evidence: clip(evidence) });
const fail = (evidence) => ({ pass: false, evidence: clip(evidence) });
const matching = (ctx, re) => ctx.commands.filter((c) => re.test(c));

// args: name -> kind (string | regex | path | number | json); `optional: true` marks non-required ones.
export const CHECKS = {
  cmd_matches: {
    args: { pattern: { kind: 'regex' }, flags: { kind: 'string', optional: true } },
    run(check, ctx) {
      const hit = matching(ctx, regexOf(check.pattern, check.flags, ctx))[0];
      return hit ? pass(`command: ${hit}`) : fail(`no Bash command matched /${check.pattern}/ (${ctx.commands.length} commands)`);
    },
  },
  no_cmd_matches: {
    args: { pattern: { kind: 'regex' }, flags: { kind: 'string', optional: true } },
    run(check, ctx) {
      const hit = matching(ctx, regexOf(check.pattern, check.flags, ctx))[0];
      return hit ? fail(`command matched /${check.pattern}/: ${hit}`) : pass(`no Bash command matched /${check.pattern}/`);
    },
  },
  cmd_before: {
    args: { first: { kind: 'regex' }, then: { kind: 'regex' }, flags: { kind: 'string', optional: true } },
    run(check, ctx) {
      const a = ctx.commands.findIndex((c) => regexOf(check.first, check.flags, ctx).test(c));
      const b = ctx.commands.findIndex((c) => regexOf(check.then, check.flags, ctx).test(c));
      if (a < 0) return fail(`no command matched /${check.first}/`);
      if (b < 0) return fail(`no command matched /${check.then}/`);
      return a < b ? pass(`#${a + 1} ${ctx.commands[a]} came before #${b + 1} ${ctx.commands[b]}`) : fail(`#${b + 1} ${ctx.commands[b]} came before #${a + 1} ${ctx.commands[a]}`);
    },
  },
  first_cmd_excludes: {
    args: { match: { kind: 'regex' }, pattern: { kind: 'regex' }, flags: { kind: 'string', optional: true } },
    run(check, ctx) {
      const first = matching(ctx, regexOf(check.match, check.flags, ctx))[0];
      if (!first) return pass(`no command matched /${check.match}/`);
      return regexOf(check.pattern, check.flags, ctx).test(first) ? fail(`first matching command contains /${check.pattern}/: ${first}`) : pass(`first matching command: ${first}`);
    },
  },
  final_includes: {
    args: { text: { kind: 'string' } },
    run: (check, ctx) => (ctx.final.includes(check.text) ? pass(`final response includes "${check.text}"`) : fail(`final response does not include "${check.text}"`)),
  },
  final_excludes: {
    args: { text: { kind: 'string' } },
    run: (check, ctx) => (ctx.final.includes(check.text) ? fail(`final response includes "${check.text}"`) : pass(`final response does not include "${check.text}"`)),
  },
  final_matches: {
    args: { pattern: { kind: 'regex' }, flags: { kind: 'string', optional: true } },
    run(check, ctx) {
      const m = ctx.final.match(regexOf(check.pattern, check.flags, ctx));
      return m ? pass(`final response matched: ${m[0]}`) : fail(`final response did not match /${check.pattern}/`);
    },
  },
  final_not_matches: {
    args: { pattern: { kind: 'regex' }, flags: { kind: 'string', optional: true } },
    run(check, ctx) {
      const m = ctx.final.match(regexOf(check.pattern, check.flags, ctx));
      return m ? fail(`final response matched /${check.pattern}/: ${m[0]}`) : pass(`final response did not match /${check.pattern}/`);
    },
  },
  file_matches: {
    args: { path: { kind: 'path' }, pattern: { kind: 'regex' }, flags: { kind: 'string', optional: true } },
    run(check, ctx) {
      const buf = readProject(ctx, check.path);
      if (!buf) return fail(`${check.path} does not exist`);
      const m = buf.toString('utf8').match(regexOf(check.pattern, check.flags, ctx));
      return m ? pass(`${check.path} matched: ${m[0]}`) : fail(`${check.path} did not match /${check.pattern}/`);
    },
  },
  file_exists: {
    args: { path: { kind: 'path' } },
    run: (check, ctx) => (readProject(ctx, check.path) ? pass(`${check.path} exists`) : fail(`${check.path} does not exist`)),
  },
  file_absent: {
    args: { path: { kind: 'path' } },
    run: (check, ctx) => (existsSync(projectFile(ctx, check.path)) ? fail(`${check.path} exists`) : pass(`${check.path} does not exist`)),
  },
  file_excludes: {
    args: { path: { kind: 'path' }, text: { kind: 'string' } },
    run(check, ctx) {
      const buf = readProject(ctx, check.path);
      if (!buf) return fail(`${check.path} does not exist`);
      return buf.toString('utf8').includes(check.text) ? fail(`${check.path} contains "${check.text}"`) : pass(`${check.path} does not contain "${check.text}"`);
    },
  },
  file_unchanged: {
    args: { path: { kind: 'path' } },
    run(check, ctx) {
      const now = readProject(ctx, check.path);
      const before = ctx.fixtureFor(check.path);
      if (!before) return fail(`${check.path} has no fixture to compare against`);
      if (!now) return fail(`${check.path} was deleted`);
      return now.equals(before) ? pass(`${check.path} is byte-for-byte unchanged`) : fail(`${check.path} differs from its fixture`);
    },
  },
  project_excludes: {
    args: { text: { kind: 'string' } },
    run(check, ctx) {
      const root = join(ctx.runDir, 'project');
      for (const rel of walkFiles(root)) {
        const full = join(root, rel);
        if (statSync(full).size > MAX_SCAN_BYTES) continue;
        if (readFileSync(full, 'utf8').includes(check.text)) return fail(`${rel} contains "${check.text}"`);
      }
      return pass(`no project file contains "${check.text}"`);
    },
  },
  skill_no_new_files: {
    args: { skill: { kind: 'string' } },
    run(check, ctx) {
      if (!ctx.pluginDir || ctx.variant === 'without_skill') return pass('no plugin installed');
      const prefix = `${ctx.skillRel[check.skill]}/`;
      const touched = [...ctx.pluginNewFiles, ...ctx.pluginChangedFiles].filter((f) => f.startsWith(prefix));
      return touched.length ? fail(`files created or changed under ${prefix}: ${touched.join(', ')}`) : pass(`nothing created or changed under ${prefix}`);
    },
  },
  yaml: {
    args: {
      path: { kind: 'path' },
      at: { kind: 'string' },
      equals: { kind: 'json', optional: true },
      matches: { kind: 'regex', optional: true },
      length: { kind: 'number', optional: true },
      minLength: { kind: 'number', optional: true },
      keys: { kind: 'json', optional: true },
      flags: { kind: 'string', optional: true },
    },
    run(check, ctx) {
      const { doc, error } = parseProjectYaml(ctx, check.path);
      if (error) return fail(error);
      const values = resolveYamlPath(doc, check.at);
      if (!values.length) return fail(`${check.path}: path "${check.at}" not found`);
      const op = YAML_OPS.find((o) => o in check);
      const detail = `${check.path} ${check.at} ${op} ${JSON.stringify(check[op])}`;
      return yamlOpResult(check, values, ctx) ? pass(`${detail}; found ${clip(JSON.stringify(values))}`) : fail(`${detail}; found ${clip(JSON.stringify(values))}`);
    },
  },
  validate_local: {
    args: { path: { kind: 'path' } },
    run(check, ctx) {
      const buf = readProject(ctx, check.path);
      if (!buf) return fail(`${check.path} does not exist`);
      const bad = validateLocal(buf.toString('utf8')).findings.filter((f) => f.severity === 'error' || f.category === 'secret');
      if (!bad.length) return pass(`${check.path}: no local validation errors or secret findings`);
      return fail(`${check.path}: ${bad.length} finding(s): ${bad.slice(0, 3).map((f) => `${f.ruleId}${f.path ? ` at ${f.path}` : ''}`).join('; ')}`);
    },
  },
  step_refs_resolve: {
    args: { path: { kind: 'path' }, at: { kind: 'string', optional: true } },
    run(check, ctx) {
      const { doc, error } = parseProjectYaml(ctx, check.path);
      if (error) return fail(error);
      const steps = flattenSteps(doc?.steps);
      const scope = check.at === undefined ? null : resolveYamlPath(doc, check.at);
      if (scope && !scope.length) return fail(`${check.path}: path "${check.at}" not found`);
      const selectors = (step) => (isObj(step.inputs) && Array.isArray(step.inputs.selectors) ? step.inputs.selectors.map((s) => s?.name) : []);
      const bad = [];
      let refs = 0;
      steps.forEach((step, i) => {
        const texts = scope ? scope.flatMap((v) => stringsOf(v)).filter((t) => stringsOf(step).includes(t)) : stringsOf(step);
        for (const text of texts) {
          for (const [ref, from, output] of text.matchAll(STEP_REF)) {
            refs += 1;
            const target = steps.slice(0, i).find((s) => s.name === from);
            if (!target) bad.push(`${ref} in ${step.name ?? `step ${i}`} (no earlier step "${from}")`);
            else if (!BUILTIN_OUTPUTS.has(output) && !selectors(target).includes(output)) bad.push(`${ref} in ${step.name ?? `step ${i}`} (${from} has no selector "${output}")`);
          }
        }
      });
      if (bad.length) return fail(`unresolved step references: ${bad.join('; ')}`);
      return refs ? pass(`${check.path}: ${refs} step output reference(s) all resolve`) : fail(`${check.path}: no \${{ .steps.<name>.outputs.<field> }} reference found`);
    },
  },
  changed_yaml_equals: {
    args: { dir: { kind: 'path' }, at: { kind: 'string' }, equals: { kind: 'json' } },
    run(check, ctx) {
      const root = join(ctx.runDir, 'project', check.dir);
      const changed = walkFiles(root).filter((f) => /\.ya?ml$/.test(f)).filter((f) => {
        const before = ctx.fixtureFor(`${check.dir}/${f}`);
        return !before || !before.equals(readFileSync(join(root, f)));
      });
      if (!changed.length) return pass(`no new or changed YAML files under ${check.dir}/`);
      const bad = [];
      for (const f of changed) {
        const { doc, error } = parseProjectYaml(ctx, `${check.dir}/${f}`);
        const values = error ? [] : resolveYamlPath(doc, check.at);
        if (!values.some((v) => isDeepStrictEqual(v, check.equals))) bad.push(`${f} (${error ?? `${check.at} = ${clip(JSON.stringify(values))}`})`);
      }
      return bad.length ? fail(`new or changed files without ${check.at} = ${JSON.stringify(check.equals)}: ${bad.join('; ')}`) : pass(`${changed.join(', ')}: ${check.at} = ${JSON.stringify(check.equals)}`);
    },
  },
};

// Returns a list of error strings (empty when valid). `skillNames` are the skills installed for the family.
export function validateChecks(checks, { assertionCount, skillNames }) {
  const errors = [];
  if (checks === undefined) return errors;
  if (!Array.isArray(checks)) return ['"checks" must be an array'];
  const dummy = { projectDir: '/p', pluginDir: '/q', skillRel: Object.fromEntries(skillNames.map((n) => [n, `skills/x/${n}`])) };
  checks.forEach((check, i) => {
    const at = `checks[${i}]`;
    if (!check || typeof check !== 'object' || Array.isArray(check)) return errors.push(`${at}: must be an object`);
    if (!Number.isInteger(check.assertion) || check.assertion < 0 || check.assertion >= assertionCount) errors.push(`${at}: "assertion" must be an integer from 0 to ${assertionCount - 1}`);
    const def = CHECKS[check.type];
    if (!def) return errors.push(`${at}: unknown type "${check.type}"`);
    const allowed = new Set([...COMMON_KEYS, ...Object.keys(def.args)]);
    for (const key of Object.keys(check)) if (!allowed.has(key)) errors.push(`${at} (${check.type}): unexpected key "${key}"`);
    if ('partial' in check && typeof check.partial !== 'boolean') errors.push(`${at}: "partial" must be a boolean`);
    if ('when_exists' in check && !isRelPath(check.when_exists)) errors.push(`${at}: "when_exists" must be a relative path inside the project`);
    for (const [name, spec] of Object.entries(def.args)) {
      if (!(name in check)) {
        if (!spec.optional) errors.push(`${at} (${check.type}): missing "${name}"`);
        continue;
      }
      const err = argError(check[name], spec.kind, dummy, check.flags);
      if (err) errors.push(`${at} (${check.type}): "${name}" ${err}`);
    }
    if (check.type === 'yaml') {
      const ops = YAML_OPS.filter((o) => o in check);
      if (ops.length !== 1) errors.push(`${at} (yaml): give exactly one of ${YAML_OPS.join(', ')}`);
      else if (ops[0] === 'keys' && !(Array.isArray(check.keys) && check.keys.every((k) => typeof k === 'string'))) errors.push(`${at} (yaml): "keys" must be an array of strings`);
    }
    if (check.type === 'skill_no_new_files' && !skillNames.includes(check.skill)) errors.push(`${at}: skill "${check.skill}" is not installed for this family`);
  });
  return errors;
}

const isRelPath = (p) => typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.split('/').includes('..');

function argError(value, kind, dummy, flags) {
  if (kind === 'json') return undefined;
  if (kind === 'number') return Number.isInteger(value) && value >= 0 ? undefined : 'must be a non-negative integer';
  if (typeof value !== 'string' || value === '') return 'must be a non-empty string';
  if (kind === 'path') return isRelPath(value) ? undefined : 'must be a relative path inside the project';
  if (kind === 'regex') {
    try {
      regexOf(value, flags, dummy);
    } catch (e) {
      return `is not a valid pattern: ${e.message}`;
    }
  }
  return undefined;
}

// Returns a list of error strings for a case's optional `guards`: assertion indexes that do not discriminate skill from
// baseline. They are graded like any other assertion but reported apart from the scored ones.
export function validateGuards(guards, { assertionCount }) {
  if (guards === undefined) return [];
  if (!Array.isArray(guards)) return ['"guards" must be an array of assertion indexes'];
  const errors = guards.filter((g) => !Number.isInteger(g) || g < 0 || g >= assertionCount).map((g) => `"guards" entry ${JSON.stringify(g)} must be an integer from 0 to ${assertionCount - 1}`);
  if (new Set(guards).size !== guards.length) errors.push('"guards" must not repeat an index');
  return errors;
}

// Grades every assertion of `evalCase`. Returns [{index, text, guard, result: PASS|FAIL|PARTIAL|MANUAL, evidence: [{type, pass, evidence}]}].
export function gradeAssertions(evalCase, ctx) {
  const checks = evalCase.checks ?? [];
  const guards = new Set(evalCase.guards ?? []);
  return evalCase.assertions.map((text, index) => {
    const guard = guards.has(index);
    const mine = checks.filter((c) => c.assertion === index);
    if (!mine.length) return { index, text, guard, result: 'MANUAL', evidence: [] };
    const evidence = mine.map((check) => {
      if (check.when_exists && !existsSync(projectFile(ctx, check.when_exists))) return { type: check.type, pass: true, evidence: `${check.when_exists} was not written` };
      try {
        return { type: check.type, ...CHECKS[check.type].run(check, ctx) };
      } catch (e) {
        return { type: check.type, pass: false, evidence: `check threw: ${e.message}` };
      }
    });
    const failed = evidence.some((e) => !e.pass);
    const result = failed ? 'FAIL' : mine.some((c) => c.partial) ? 'PARTIAL' : 'PASS';
    return { index, text, guard, result, evidence };
  });
}
