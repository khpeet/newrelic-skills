#!/usr/bin/env node
// Publish a New Relic Workflow Automation definition: validate (local + server), decide create vs update by the
// workflow's exact name, then (apply only) run the matching NerdGraph mutation.
// Prints JSON to stdout, diagnostics to stderr. Never prompts.

import { parseArgs } from 'node:util';
import { ApiError, UsageError, checkEnv, getConfig, nerdgraph, resolveAccountId } from './lib/nerdgraph.mjs';
import { MAX_SCAN_CHARS, SENSITIVE_KEY, TOKEN_PATTERNS, WEBHOOK_KEY, readTarget, validateAll } from './lib/validation.mjs';
import { encodeYaml, findWorkflow, getDefinition, listWorkflows, normalizeNewlines, sha12 } from './lib/workflows.mjs';
import { assertCommandFirst, printJson, reportError, runIfMain } from './lib/cli.mjs';
import { assertNotInSkillDir, skillDirOf } from './lib/paths.mjs';

const SKILL_DIR = skillDirOf(import.meta.url);
// Identifies this skill in the User-Agent of every NerdGraph request. Keep version equal to SKILL.md metadata.version
// (test/workflow-automation/client-version.test.mjs checks it).
export const CLIENT = { skill: 'publish-workflow', version: '0.3.1' };

const USAGE = `Usage: node publish-workflow.mjs <command> [options]

Commands:
  env                                   Show which NEW_RELIC_* variables are set (values never printed)
  plan <file-or-name> [--account <id>]  Read-only: validate (local + server), then report whether publishing
                                        would create a NEW workflow, update an existing one (with a diff), or
                                        conflict with an existing name that differs only in letter case.
  apply <file-or-name> --expect <token> [--account <id>]
                                        Re-run plan; publish only if it yields exactly the "expect" token that
                                        plan returned: create#<sha12> or update@<currentVersion>#<sha12>, where
                                        sha12 identifies the account, region, and exact file bytes. A "conflict" plan is always refused.

Target:
  <file-or-name>   A path (contains "/" or ends in .yaml/.yml), or a workflow name resolved in ./workflows/
                   by filename first, then by the top-level "name:" field (case-insensitive).
  --stdin          Read the YAML from stdin instead.

Environment:
  NEW_RELIC_API_KEY     User API key (required; publishing never happens without server validation)
  NEW_RELIC_ACCOUNT_ID  Default account id (overridden by --account)
  NEW_RELIC_REGION      US (default), EU, or JP

Examples (run from the user's project directory; <skill-dir> is this skill's absolute path):
  node <skill-dir>/scripts/publish-workflow.mjs plan workflows/example_workflow.yaml --account 1234567
  node <skill-dir>/scripts/publish-workflow.mjs apply workflows/example_workflow.yaml --account 1234567 --expect update@3#4f9c2a1b7e0d
  node <skill-dir>/scripts/publish-workflow.mjs apply workflows/example_workflow.yaml --account 1234567 --expect create#4f9c2a1b7e0d
  (--expect is always the exact token the plan printed and the user confirmed; the values above are illustrative.)

Exit codes: 0 ok, 1 usage error (including missing NEW_RELIC_API_KEY) or refused, 2 API error (including invalid key /
HTTP 401/403), 3 validation errors found.`;

export const CREATE_MUTATION = `mutation CreateWorkflow($scopeId: String!, $yaml: SecureValue!) {
  workflowAutomationCreateWorkflowDefinition(scope: {id: $scopeId, type: ACCOUNT}, definition: {yaml: $yaml}) {
    definition { definitionId name version description }
  }
}`;

export const UPDATE_MUTATION = `mutation UpdateWorkflow($scopeId: String!, $yaml: SecureValue!) {
  workflowAutomationUpdateWorkflowDefinition(scope: {id: $scopeId, type: ACCOUNT}, definition: {yaml: $yaml}) {
    definition { definitionId name version description }
  }
}`;

// create#<sha12> or update@<currentVersion>#<sha12>; sha12 covers the account id, the region, and the exact UTF-8 bytes that are published.
const EXPECT_RE = /^(?:(create)|(update)@(\d+))#([0-9a-f]{12})$/;
const EXPECT_USAGE = 'apply requires --expect <token>: the exact "expect" value from plan (create#<sha12> or update@<version>#<sha12>) that the user confirmed. A bare create or update is not accepted; run plan again and confirm with the user.';
const contentHash = (text, accountId, region) => sha12(Buffer.from(`${accountId}\n${region}\n${text}`, 'utf8'));

const CONTEXT_LINES = 3;
const MAX_DIFF_LINES = 400;

const toLines = (text) => {
  const normalized = normalizeNewlines(text);
  return normalized === '' ? [] : normalized.split('\n');
};

// LCS line diff -> [{op: ' '|'-'|'+', line}]. Common prefix/suffix are trimmed first to keep the table small.
function diffOps(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start;
  const m = endB - start;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[start + i] === b[start + j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const ops = a.slice(0, start).map((line) => ({ op: ' ', line }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      ops.push({ op: ' ', line: a[start + i] }); i++; j++;
    } else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
      ops.push({ op: '-', line: a[start + i] }); i++;
    } else {
      ops.push({ op: '+', line: b[start + j] }); j++;
    }
  }
  for (const line of a.slice(endA)) ops.push({ op: ' ', line });
  return ops;
}

// The published version may hold plaintext secrets the local file no longer has; never echo them in the diff.
const SENSITIVE_LINE = /^([+\- ]\s*(?:-\s+)?["']?([\w-]+)["']?\s*:\s*)(\S.*)$/;
const EMPTY_KEY_LINE = /^[+\- ]\s*(?:-\s+)?["']?([\w-]+)["']?\s*:\s*$/;
const KEY_LINE = /^(\s*(?:-\s+)?)["']?([\w-]+)["']?\s*:\s*(.*)$/;
const isSensitiveKey = (key) => SENSITIVE_KEY.test(key) || WEBHOOK_KEY.test(key);
// Column of a diff line's mapping key: indentation after the +/-/space marker, plus any "- " list-item prefix.
const keyColumn = (line) => line.slice(1).match(/^\s*(?:-\s+)?/)[0].length;

// 1-based numbers of the lines nested under a sensitive key that has a block scalar (`key: |`) or no inline value
// (`key:`), found on the whole document so a diff hunk that starts inside the block is still masked.
function sensitiveBlockLines(lines) {
  const masked = new Set();
  let column = null;
  lines.forEach((line, idx) => {
    if (column !== null) {
      if (!line.trim()) return;
      if (line.match(/^\s*/)[0].length > column) {
        masked.add(idx + 1);
        return;
      }
      column = null;
    }
    const kv = line.match(KEY_LINE);
    if (!kv || !isSensitiveKey(kv[2]) || kv[3].includes('${{')) return;
    const value = kv[3].trim();
    if (value === '' || /^[|>]/.test(value)) column = kv[1].length;
  });
  return masked;
}

// Unified diff with CONTEXT_LINES of context, truncated at MAX_DIFF_LINES output lines.
// maskSecrets renders lines nested under sensitive keys as [REDACTED] (the real lines are still diffed) and sets `redacted`.
export function unifiedDiff(oldText, newText, { oldLabel = 'a', newLabel = 'b', maskSecrets = false } = {}) {
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);
  const ops = diffOps(oldLines, newLines);
  const added = ops.filter((o) => o.op === '+').length;
  const removed = ops.filter((o) => o.op === '-').length;
  const stats = { added, removed };
  if (added === 0 && removed === 0) return { diff: '', truncated: false, stats, redacted: false };

  // Line numbers before each op, then group changes into hunks.
  let oldNo = 1;
  let newNo = 1;
  const numbered = ops.map((o) => {
    const entry = { ...o, oldNo, newNo };
    if (o.op !== '+') oldNo++;
    if (o.op !== '-') newNo++;
    return entry;
  });
  const changed = numbered.map((o, idx) => (o.op === ' ' ? -1 : idx)).filter((idx) => idx >= 0);
  const hunks = [];
  for (const idx of changed) {
    const from = Math.max(0, idx - CONTEXT_LINES);
    const to = Math.min(numbered.length - 1, idx + CONTEXT_LINES);
    const last = hunks.at(-1);
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else hunks.push({ from, to });
  }

  const maskOld = maskSecrets ? sensitiveBlockLines(oldLines) : new Set();
  const maskNew = maskSecrets ? sensitiveBlockLines(newLines) : new Set();
  let redacted = false;
  const render = (o) => {
    const masked = o.op === '+' ? maskNew.has(o.newNo) : o.op === '-' ? maskOld.has(o.oldNo) : maskOld.has(o.oldNo) || maskNew.has(o.newNo);
    if (!masked) return `${o.op}${o.line}`;
    redacted = true;
    return `${o.op}${o.line.match(/^\s*/)[0]}[REDACTED]`;
  };

  const out = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const { from, to } of hunks) {
    const slice = numbered.slice(from, to + 1);
    const oldCount = slice.filter((o) => o.op !== '+').length;
    const newCount = slice.filter((o) => o.op !== '-').length;
    const oldStart = oldCount ? slice.find((o) => o.op !== '+').oldNo : slice[0].oldNo - 1;
    const newStart = newCount ? slice.find((o) => o.op !== '-').newNo : slice[0].newNo - 1;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const o of slice) out.push(render(o));
  }
  const truncated = out.length > MAX_DIFF_LINES;
  return { diff: `${out.slice(0, MAX_DIFF_LINES).join('\n')}\n`, truncated, stats, redacted };
}

// Sensitive `key: value` pairs inside flow mappings ({Authorization: x}) and JSON strings ('{"X-Api-Key": "x"}').
function redactInline(line) {
  const refs = [...line.matchAll(/\$\{\{.*?\}\}/g)].map((r) => [r.index, r.index + r[0].length]);
  let out = '';
  let last = 0;
  for (const m of line.matchAll(/(?<![\w-])(["']?)([\w-]+)\1\s*:\s*/g)) {
    const start = m.index + m[0].length;
    if (start < last || !isSensitiveKey(m[2]) || refs.some(([from, to]) => m.index >= from && m.index < to)) continue;
    const rest = line.slice(start);

    const quoted = rest.match(/^"(?:[^"\\]|\\.)*"|^'[^']*'/);
    const value = (quoted ? quoted[0] : rest.match(/^[^,}\]]*/)[0]).trimEnd();
    if (!value || /^[|>]/.test(value) || value.includes('${{') || /^[^,}]*\[REDACTED\]/.test(rest)) continue;
    out += `${line.slice(last, start)}[REDACTED]`;
    last = start + value.length;
  }
  return last ? out + line.slice(last) : line;
}

export function redactDiff(diff, apiKey) {
  let redacted = false;
  // Set while inside a block scalar (`key: |` or `key: >`) under a sensitive key: lines indented deeper are its value.
  let blockColumn = null;
  const lines = diff.split('\n').map((line) => {
    if (/^(---|\+\+\+|@@) /.test(line)) {
      blockColumn = null;
      return line;
    }
    const body = line.slice(1);
    if (blockColumn !== null) {
      if (!body.trim()) return line;
      const indent = body.match(/^\s*/)[0];
      if (indent.length > blockColumn) {
        redacted = true;
        return `${line[0]}${indent}[REDACTED]`;
      }
      blockColumn = null;
    }
    // Lines past the scan cap are not pattern-scanned (that is where the quadratic cost is), so none of their content is
    // shown: a secret in the tail would otherwise leak.
    if (body.length > MAX_SCAN_CHARS) {
      redacted = true;
      return `${line[0]}[REDACTED: ${body.length}-char line not shown]`;
    }
    let out = apiKey ? line.split(apiKey).join('[REDACTED]') : line;
    for (const [, pattern] of TOKEN_PATTERNS) out = out.replace(new RegExp(pattern.source, `${pattern.flags}g`), (m) => `${m.slice(0, 4)}…[REDACTED]`);
    const kv = out.match(SENSITIVE_LINE);
    if (kv && isSensitiveKey(kv[2]) && !kv[3].includes('${{') && !kv[3].includes('[REDACTED]')) {
      if (/^[|>]/.test(kv[3])) blockColumn = keyColumn(line);
      else out = `${kv[1]}[REDACTED]`;
    }
    const empty = out.match(EMPTY_KEY_LINE);
    if (empty && isSensitiveKey(empty[1])) blockColumn = keyColumn(line);
    out = redactInline(out);
    if (out !== line) redacted = true;
    return out;
  });
  return { diff: lines.join('\n'), redacted };
}

// Shared by plan and apply. Returns {exitCode, result, config?, accountId?}; exitCode 3 means validation failed.
export async function planPublish({ file, text, account, env, fetchImpl }) {
  const opts = fetchImpl ? { fetchImpl } : {};
  const local = await validateAll(text, { account, env, fetchImpl, client: CLIENT });
  const { server } = local;
  // Info findings are best-practice hints for the validate-workflow skill; plan lists errors and warnings and counts the rest.
  const validation = { summary: local.summary, findings: local.findings.filter((f) => f.severity !== 'info') };
  const name = typeof local.doc?.name === 'string' ? local.doc.name : null;

  if (validation.summary.errors > 0) {
    return { exitCode: 3, result: { file, name, publishable: false, validation } };
  }
  if (!server.ran) {
    // Credential problems are the user's to fix (usage); anything else is an API failure.
    try {
      resolveAccountId(account, getConfig(env));
    } catch (err) {
      throw new UsageError(`Server validation is required before publishing: ${err.message}`);
    }
    throw new ApiError(`Server validation could not run (${server.error}). Not publishing without server validation.`);
  }

  const config = getConfig(env, CLIENT);
  const accountId = resolveAccountId(account, config);
  const workflows = await listWorkflows(accountId, config, opts);
  const { match, caseVariants } = findWorkflow(workflows, name);
  // Names are unique case-insensitively (verified live): with no exact match, a case variant blocks Create.
  const nearMatches = caseVariants.map((w) => w.name);
  const warnings = [];

  if (!match && nearMatches.length) {
    const existingName = nearMatches[0];
    warnings.push(conflictMessage(name, existingName));
    const result = { file, name, accountId, action: 'conflict', existingName, publishable: false, nearMatches, validation, warnings };
    return { exitCode: 0, result, config, accountId };
  }

  let result;
  if (match) {
    const { yaml: current } = await getDefinition(accountId, name, match.latestVersion, config, opts);
    const unchanged = normalizeNewlines(current) === normalizeNewlines(text);
    const { diff, truncated, stats, redacted: masked } = unifiedDiff(current, text, { oldLabel: `${name} v${match.latestVersion} (New Relic)`, newLabel: file, maskSecrets: true });
    result = { file, name, accountId, action: 'update', currentVersion: match.latestVersion, nextVersion: match.latestVersion + 1, unchanged };
    if (unchanged) warnings.push(`The file is identical to the published version ${match.latestVersion}; there is nothing to publish.`);
    else {
      const safe = redactDiff(diff, config.apiKey);
      if (safe.redacted || masked) warnings.push('Values that look like plaintext secrets were redacted from the diff. If the published version contains them, they remain in its version history.');
      Object.assign(result, { diff: safe.diff, ...(truncated ? { diffTruncated: true } : {}) });
    }
    result.diffStats = stats;
  } else {
    warnings.unshift(`Creates a NEW workflow; the name '${name}' can never be changed.`);
    result = { file, name, accountId, action: 'create', diffStats: { added: toLines(text).length, removed: 0 } };
  }
  const publishable = !result.unchanged;
  const expect = publishable ? `${result.action === 'update' ? `update@${result.currentVersion}` : 'create'}#${contentHash(text, accountId, config.region)}` : undefined;
  Object.assign(result, { publishable, ...(expect ? { expect } : {}), ...(nearMatches.length ? { nearMatches } : {}), validation, warnings });
  return { exitCode: 0, result, config, accountId };
}

const conflictMessage = (name, existingName) => `A workflow named '${existingName}' already exists. Names are case-insensitive, so creating '${name}' will fail. To update the existing workflow, change name: to exactly '${existingName}'.`;

async function applyPublish(plan, { expect, text, fetchImpl }) {
  const { result, config, accountId } = plan;
  const [, isCreate, , expectVersion, expectHash] = expect.match(EXPECT_RE);
  const expectAction = isCreate ? 'create' : 'update';
  if (result.action === 'conflict') {
    throw new UsageError(`Refusing to publish: ${conflictMessage(result.name, result.existingName)}`);
  }
  if (result.action !== expectAction) {
    throw new UsageError(`Refusing to publish: --expect ${expect} but publishing '${result.name}' would ${result.action === 'create' ? 'CREATE a new workflow' : `UPDATE the existing workflow (v${result.currentVersion} -> v${result.nextVersion})`}. Run plan again and confirm with the user.`);
  }
  if (result.unchanged) {
    throw new UsageError(`Refusing to publish: '${result.name}' is identical to published version ${result.currentVersion}; nothing to publish.`);
  }
  const changes = [];
  if (expectAction === 'update' && Number(expectVersion) !== result.currentVersion) {
    changes.push(`the latest published version moved from v${expectVersion} to v${result.currentVersion} (someone published in the meantime)`);
  }
  const actualHash = contentHash(text, accountId, config.region);
  if (expectHash !== actualHash) {
    changes.push(`the content to publish changed since plan, or the account or region differs from the plan (#${expectHash} -> #${actualHash})`);
  }
  if (changes.length) {
    throw new UsageError(`Refusing to publish '${result.name}': ${changes.join('; and ')}. Run plan again, show the user the new result, and confirm with them.`);
  }
  const mutation = expectAction === 'create' ? CREATE_MUTATION : UPDATE_MUTATION;
  const field = expectAction === 'create' ? 'workflowAutomationCreateWorkflowDefinition' : 'workflowAutomationUpdateWorkflowDefinition';
  const data = await nerdgraph(mutation, { scopeId: String(accountId), yaml: encodeYaml(text) }, config, fetchImpl ? { fetchImpl } : {});
  const definition = data?.[field]?.definition;
  if (!definition) throw new ApiError(`NerdGraph returned an unexpected ${expectAction} response.`);
  return {
    action: expectAction,
    name: definition.name,
    version: Number(definition.version),
    definitionId: definition.definitionId,
    accountId,
    hint: 'Start a run with the run-workflow skill or from Workflow Automation in the New Relic UI.',
  };
}

export async function main(argv, { env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), fetchImpl } = {}) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        account: { type: 'string' },
        expect: { type: 'string' },
        stdin: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    const [command, ...rest] = positionals;
    if (values.help || !command) {
      (values.help ? stdout : stderr).write(`${USAGE}\n`);
      return values.help ? 0 : 1;
    }
    assertCommandFirst(argv, command, 'publish-workflow.mjs');
    assertNotInSkillDir(cwd, SKILL_DIR);

    let result;
    let exitCode = 0;
    if (command === 'env') {
      result = checkEnv(env);
    } else if (command === 'plan' || command === 'apply') {
      if (command === 'apply' && !EXPECT_RE.test(values.expect ?? '')) throw new UsageError(EXPECT_USAGE);
      if (command === 'plan' && values.expect !== undefined) throw new UsageError('--expect is only valid with apply.');
      const { file, text } = await readTarget(values, rest, stdin, cwd, USAGE);
      const plan = await planPublish({ file, text, account: values.account, env, fetchImpl });
      exitCode = plan.exitCode;
      result = command === 'apply' && exitCode === 0 ? await applyPublish(plan, { expect: values.expect, text, fetchImpl }) : plan.result;
    } else {
      throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
    }
    printJson(stdout, result);
    return exitCode;
  } catch (err) {
    return reportError(err, stderr);
  }
}

await runIfMain(import.meta.url, main);
