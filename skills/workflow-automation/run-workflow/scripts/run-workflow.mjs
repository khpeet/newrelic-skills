#!/usr/bin/env node
// Start a run of a published New Relic Workflow Automation definition: resolve the published name and version, check
// the run inputs against its workflowInputs, then (start only) call the start mutation and confirm the run began.
// Prints JSON to stdout, diagnostics to stderr. Never prompts, and never waits for the run to finish.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkRunInputs, parseInputArgs } from './lib/inputs.mjs';
import { ApiError, UsageError, checkEnv, getConfig, nerdgraph, resolveAccountId } from './lib/nerdgraph.mjs';
import { resolveTarget } from './lib/validation.mjs';
import { NAME_RE, findWorkflow, getDefinition, listWorkflows, normalizeNewlines, parseVersion, sha12 } from './lib/workflows.mjs';
import { assertCommandFirst, printJson, reportError, runIfMain } from './lib/cli.mjs';
import { assertNotInSkillDir, skillDirOf } from './lib/paths.mjs';
import { collectSteps, isMap } from './lib/steps.mjs';
import { truncate } from './lib/text.mjs';
import { parseYaml } from './lib/yaml.mjs';

const SKILL_DIR = skillDirOf(import.meta.url);
// Identifies this skill in the User-Agent of every NerdGraph request. Keep version equal to SKILL.md metadata.version
// (test/workflow-automation/client-version.test.mjs checks it).
export const CLIENT = { skill: 'run-workflow', version: '0.5.0' };

const USAGE = `Usage: node run-workflow.mjs <command> [options]

Commands:
  env                                   Show which NEW_RELIC_* variables are set (values never printed) and the temp dir
  plan <name-or-file> [run options]     Read-only: find the published workflow and version, check the inputs,
                                        and report what start would run.
  start <name-or-file> --expect <name>@<version>#<inputsHash> [run options] [--idempotency-key <uuid>]
                                        Re-run plan; start the run only if it yields exactly the "expect" token
                                        that plan returned (same name, version, inputs, and log level). Waits
                                        about 15-30 seconds to confirm the run started, then returns its logUrl.
  status <runId> [--account <id>]       Read-only: one status check of a run (never waits).

Target:
  <name-or-file>   A path (contains "/" or ends in .yaml/.yml), a local workflow in ./workflows/ (by filename,
                   then by "name:"), or the name of a published workflow. The PUBLISHED definition always runs.

Run options:
  --version <n>          Published version to run (default: latest)
  --input <key=value>    A workflow input (repeatable). Values are sent as strings.
  --inputs-file <path>   Workflow inputs from a JSON object file (preferred: no shell quoting)
  --inputs-json <json>   Workflow inputs as a JSON object (List/Map values may be JSON arrays/objects)
  --log-level <level>    DEBUG, INFO, NONE, or TRACE (default: the server's)
  --account <id>         Account id (default: NEW_RELIC_ACCOUNT_ID)

Environment:
  NEW_RELIC_API_KEY     User API key (required)
  NEW_RELIC_ACCOUNT_ID  Default account id (overridden by --account)
  NEW_RELIC_REGION      US (default), EU, or JP

Examples (run from the user's project directory; <skill-dir> is this skill's absolute path):
  node <skill-dir>/scripts/run-workflow.mjs plan example_workflow --account 1234567 --inputs-file inputs.json
  node <skill-dir>/scripts/run-workflow.mjs start example_workflow --account 1234567 --inputs-file inputs.json --expect example_workflow@2#9b1e04c7d3a2
  node <skill-dir>/scripts/run-workflow.mjs status 3fa85f64-5717-4562-b3fc-2c963f66afa6 --account 1234567
  (--expect is always the exact token the plan printed and the user confirmed; the values above are illustrative.)

Exit codes: 0 ok, 1 usage error (including missing NEW_RELIC_API_KEY) or refused, 2 API error (including invalid key /
HTTP 401/403) or not found, 3 input errors, 4 run failed or timed out.`;

export const START_MUTATION = `mutation StartWorkflowRun($scopeId: String!, $name: String!, $version: Int, $workflowInputs: [WorkflowAutomationWorkflowRunInput!], $idempotencyKey: ID, $options: WorkflowAutomationWorkflowRunOptions) {
  workflowAutomationStartWorkflowRun(scope: {id: $scopeId, type: ACCOUNT}, definition: {name: $name, version: $version}, workflowInputs: $workflowInputs, idempotencyKey: $idempotencyKey, options: $options) {
    runId
  }
}`;

export const RUN_INFO_QUERY = `query WorkflowRunInfo($accountId: Int!, $runId: ID!) {
  actor { account(id: $accountId) { workflowAutomation {
    workflowRunInfo(runId: $runId) { status logUrl state { key value } }
  } } }
}`;

const LOG_LEVELS = ['DEBUG', 'INFO', 'NONE', 'TRACE'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// <name>@<version>#<inputsHash>; the hash covers the supplied inputs as sent, the log level, the account id, and the region.
const EXPECT_RE = /^(.+)@(\d+)#([0-9a-f]{12})$/;
const FAILED = ['FAILED', 'TIMED_OUT'];
// start checks the run once after this delay, then once more if run info is not available yet (~30 s in total).
const CONFIRM_DELAY_MS = 15_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
const inputsHash = (inputs, logLevel, accountId, region) => sha12(JSON.stringify({
  inputs: inputs.filter((i) => i.source === 'supplied').map(({ key, value }) => [key, value]).sort(byKey),
  logLevel,
  accountId,
  region,
}));
const statusHint = (runId) => `Check it later (only if the user asks) with: status ${runId}`;

// The first YAML document as a mapping, or null if the text does not parse. Only name, inputs, and steps are read here;
// validate-workflow and publish-workflow do the real checking.
function parseDoc(text) {
  try {
    const [doc] = parseYaml(text);
    return isMap(doc) ? doc : null;
  } catch {
    return null;
  }
}

// A path or a local ./workflows/ match is read for its name:; anything else is taken as a published workflow name.
function readTarget(target, cwd) {
  let file;
  try {
    file = resolveTarget(target, cwd);
  } catch (err) {
    const looksLikePath = target.includes('/') || target.includes('\\') || /\.ya?ml$/i.test(target);
    if (looksLikePath || !/^No workflow named/.test(err.message)) throw err;
  }
  if (!file) {
    if (!NAME_RE.test(target)) throw new UsageError(`"${target}" is not a valid workflow name (must match ${NAME_RE}) and no such local file exists.`);
    return { name: target };
  }
  const text = readFileSync(file, 'utf8');
  const doc = parseDoc(text);
  if (typeof doc?.name !== 'string' || !NAME_RE.test(doc.name)) {
    const looksLikePath = target.includes('/') || target.includes('\\') || /\.ya?ml$/i.test(target);
    throw new UsageError(looksLikePath
      ? `${file} has no valid top-level "name:"; run the validate-workflow skill on it.`
      : `${file} matches "${target}" but has no valid top-level "name:", so it cannot be used. Fix it (validate-workflow skill), or move or rename it to run the published workflow of that name.`);
  }
  return { file, text, name: doc.name };
}

function readInputsFile(path, cwd) {
  if (path === undefined) return undefined;
  const full = resolve(cwd, path);
  if (!existsSync(full)) throw new UsageError(`--inputs-file not found: ${full}`);
  return { path: full, text: readFileSync(full, 'utf8') };
}

function parseRunOptions(values, cwd) {
  const version = parseVersion(values.version);
  let logLevel = null;
  if (values['log-level'] !== undefined) {
    logLevel = values['log-level'].toUpperCase();
    if (!LOG_LEVELS.includes(logLevel)) throw new UsageError(`--log-level must be one of ${LOG_LEVELS.join(', ')} (got "${values['log-level']}").`);
  }
  const supplied = parseInputArgs(values.input, values['inputs-json'], readInputsFile(values['inputs-file'], cwd));
  return { version, logLevel, supplied };
}

// What plan prints for the resolved inputs. Names and default values come from the published definition (untrusted), so
// they are bounded for display; the full list stays in the plan's `resolved` for the hash and the start mutation.
const displayInputs = (resolved) => resolved.map((i) => ({
  ...i,
  key: truncate(i.key),
  ...(i.source === 'default' && typeof i.value === 'string' ? { value: truncate(i.value) } : {}),
}));

// Shared by plan and start. Returns {exitCode, result, config, accountId, supplied}; exitCode 3 means input errors.
export async function planRun({ target, values, env, cwd, fetchImpl }) {
  const opts = fetchImpl ? { fetchImpl } : {};
  const { version: wantedVersion, logLevel, supplied } = parseRunOptions(values, cwd);
  const local = readTarget(target, cwd);
  const { name } = local;
  const config = getConfig(env, CLIENT);
  const accountId = resolveAccountId(values.account, config);

  const workflows = await listWorkflows(accountId, config, opts);
  const { match, caseVariants } = findWorkflow(workflows, name);
  if (!match) {
    const near = caseVariants[0];
    // Runs are started by exact name; a case variant is a different spelling, not this workflow.
    if (near) throw new UsageError(`Refusing to run: no workflow named '${name}' in account ${accountId}, but '${near.name}' exists (names differ only in letter case). Use the exact name '${near.name}'.`);
    throw new ApiError(`No published workflow named '${name}' in account ${accountId}. Publish it first with the publish-workflow skill.`);
  }
  const version = wantedVersion ?? match.latestVersion;
  if (!match.versions.includes(version)) {
    throw new ApiError(`Workflow '${name}' has no version ${version} in account ${accountId} (published versions: ${match.versions.join(', ')}).`);
  }

  const { yaml: published } = await getDefinition(accountId, name, version, config, opts);
  const doc = parseDoc(published);
  if (!doc) throw new ApiError(`Published workflow "${name}" version ${version} could not be parsed as YAML.`);

  const warnings = [];
  const result = { ...(local.file ? { file: local.file } : {}), name, version, latestVersion: match.latestVersion, accountId };
  if (local.file) {
    result.localDiffers = normalizeNewlines(local.text) !== normalizeNewlines(published);
    if (result.localDiffers) warnings.push(`${local.file} differs from published version ${version}. The PUBLISHED version runs, not the local edits; publish first (publish-workflow skill) to run them.`);
  }
  if (version !== match.latestVersion) warnings.push(`Version ${version} is not the latest published version (${match.latestVersion}).`);

  const { resolved, findings } = checkRunInputs(doc.workflowInputs, supplied);
  const steps = collectSteps(doc.steps).map(({ step }) => step).filter(isMap);
  const startable = !findings.some((f) => f.severity === 'error');
  Object.assign(result, {
    description: typeof doc.description === 'string' ? truncate(doc.description) : null,
    inputs: displayInputs(resolved),
    declaredInputs: isMap(doc.workflowInputs) ? Object.keys(doc.workflowInputs).map((n) => truncate(n)) : [],
    steps: steps.length,
    actions: [...new Set(steps.filter((s) => s.type === 'action' && typeof s.action === 'string').map((s) => truncate(s.action)))],
    logLevel,
    startable,
    findings,
    warnings,
  });
  if (!startable) return { exitCode: 3, result };
  result.expect = `${name}@${version}#${inputsHash(resolved, logLevel, accountId, config.region)}`;
  return { exitCode: 0, result, config, accountId, supplied, resolved };
}

async function fetchRunInfo(runId, accountId, config, opts) {
  const data = await nerdgraph(RUN_INFO_QUERY, { accountId, runId }, config, opts);
  return data?.actor?.account?.workflowAutomation?.workflowRunInfo ?? null;
}

async function startRun(plan, { expect, idempotencyKey, fetchImpl, sleep }) {
  const { result, config, accountId, resolved } = plan;
  const opts = fetchImpl ? { fetchImpl } : {};
  const [, expectName, expectVersion, expectHash] = expect.match(EXPECT_RE);
  const changes = [];
  if (expectName !== result.name || Number(expectVersion) !== result.version) changes.push(`it would run ${result.name}@${result.version}`);
  if (expectHash !== inputsHash(resolved, result.logLevel, accountId, config.region)) changes.push('the inputs, log level, account, or region differ from the plan the user confirmed');
  if (changes.length) {
    throw new UsageError(`Refusing to start: --expect ${expect} but ${changes.join(', and ')} (plan now gives ${result.expect}). Run plan again with the intended options and confirm with the user.`);
  }

  // Defaults are not sent; the server applies them. The version is pinned to the one the user confirmed.
  const workflowInputs = resolved.filter((i) => i.source === 'supplied').map(({ key, value }) => ({ key, value }));
  const variables = {
    scopeId: String(accountId),
    name: result.name,
    version: result.version,
    workflowInputs: workflowInputs.length ? workflowInputs : null,
    idempotencyKey,
    options: result.logLevel ? { logLevel: result.logLevel } : null,
  };
  let runId;
  try {
    const data = await nerdgraph(START_MUTATION, variables, config, opts);
    runId = data?.workflowAutomationStartWorkflowRun?.runId;
    if (!runId) throw new ApiError('NerdGraph returned an unexpected start response.');
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    throw new ApiError(`${err.message} (idempotencyKey ${idempotencyKey}). Retrying start with --idempotency-key ${idempotencyKey} is safe and will not start a second run.`);
  }

  // Confirm the run began; retry once if run info is not available yet.
  let info = null;
  for (let attempt = 0; attempt < 2 && !info; attempt++) {
    await sleep(CONFIRM_DELAY_MS);
    try {
      info = await fetchRunInfo(runId, accountId, config, opts);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    }
  }
  const status = info?.status ?? 'UNKNOWN';
  const hints = {
    RUNNING: `The run is in progress in New Relic. Give the user the logUrl to follow it; do not wait or poll. ${statusHint(runId)}`,
    COMPLETED: 'The run already completed. Give the user the logUrl for the step details.',
    FAILED: 'The run FAILED. Give the user the logUrl to see which step failed and why.',
    TIMED_OUT: 'The run TIMED_OUT. Give the user the logUrl to see where it stopped.',
    UNKNOWN: `The run was started, but its status was not available yet. ${statusHint(runId)}`,
  };
  const out = {
    runId,
    idempotencyKey,
    name: result.name,
    version: result.version,
    accountId,
    started: true,
    status,
    logUrl: info?.logUrl ?? null,
    hint: hints[status] ?? `The run reported status ${status}. Give the user the logUrl. ${statusHint(runId)}`,
  };
  return { exitCode: FAILED.includes(status) ? 4 : 0, result: out };
}

// Run state comes from external systems (HTTP replies, chat messages), so it is untrusted and unbounded: bound what is printed.
const MAX_STATE_ENTRIES = 20;
const MAX_STATE_VALUE_CHARS = 200;
function capState(state) {
  const entries = Array.isArray(state) ? state : [];
  let truncated = entries.length > MAX_STATE_ENTRIES;
  const capped = entries.slice(0, MAX_STATE_ENTRIES).map((entry) => {
    const value = entry?.value;
    if (typeof value !== 'string' || value.length <= MAX_STATE_VALUE_CHARS) return entry;
    truncated = true;
    return { ...entry, value: `${value.slice(0, MAX_STATE_VALUE_CHARS)}… (+${value.length - MAX_STATE_VALUE_CHARS} chars)` };
  });
  return { state: capped, truncated };
}

async function runStatus(runId, { account, env, fetchImpl }) {
  const config = getConfig(env, CLIENT);
  const accountId = resolveAccountId(account, config);
  const info = await fetchRunInfo(runId, accountId, config, fetchImpl ? { fetchImpl } : {});
  if (!info) throw new ApiError(`No workflow run "${runId}" found in account ${accountId}.`);
  const { state, truncated } = capState(info.state);
  const result = { runId, accountId, status: info.status, logUrl: info.logUrl, state, ...(truncated ? { stateTruncated: true } : {}) };
  return { exitCode: FAILED.includes(info.status) ? 4 : 0, result };
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), fetchImpl, sleep = defaultSleep } = {}) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        account: { type: 'string' },
        version: { type: 'string' },
        input: { type: 'string', multiple: true, default: [] },
        'inputs-json': { type: 'string' },
        'inputs-file': { type: 'string' },
        'log-level': { type: 'string' },
        expect: { type: 'string' },
        'idempotency-key': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    const [command, ...rest] = positionals;
    if (values.help || !command) {
      (values.help ? stdout : stderr).write(`${USAGE}\n`);
      return values.help ? 0 : 1;
    }
    assertCommandFirst(argv, command, 'run-workflow.mjs');
    assertNotInSkillDir(cwd, SKILL_DIR);

    let result;
    let exitCode = 0;
    if (command === 'env') {
      result = { ...checkEnv(env), tmpDir: tmpdir() };
    } else if (command === 'plan' || command === 'start') {
      if (rest.length !== 1) throw new UsageError(`Pass exactly one <name-or-file>.\n\n${USAGE}`);
      if (command === 'plan' && (values.expect !== undefined || values['idempotency-key'] !== undefined)) {
        throw new UsageError('--expect and --idempotency-key are only valid with start.');
      }
      let idempotencyKey;
      if (command === 'start') {
        if (!EXPECT_RE.test(values.expect ?? '')) {
          throw new UsageError('start requires --expect <name>@<version>#<inputsHash>: the exact "expect" value shown by plan and confirmed by the user. A bare <name>@<version> is not accepted; run plan again and confirm with the user.');
        }
        idempotencyKey = values['idempotency-key'] ?? randomUUID();
        if (!UUID_RE.test(idempotencyKey)) throw new UsageError(`--idempotency-key must be a UUID (got "${idempotencyKey}").`);
      }
      const plan = await planRun({ target: rest[0], values, env, cwd, fetchImpl });
      ({ exitCode, result } = command === 'start' && plan.exitCode === 0
        ? await startRun(plan, { expect: values.expect, idempotencyKey, fetchImpl, sleep })
        : plan);
    } else if (command === 'status') {
      if (rest.length !== 1 || !rest[0].trim()) throw new UsageError(`Pass exactly one <runId>.\n\n${USAGE}`);
      ({ exitCode, result } = await runStatus(rest[0], { account: values.account, env, fetchImpl }));
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
