#!/usr/bin/env node
// Fetch New Relic Workflow Automation definitions via NerdGraph.
// Prints JSON to stdout, diagnostics to stderr. Never prompts.

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ApiError, UsageError, checkEnv, getConfig, resolveAccountId } from './lib/nerdgraph.mjs';
import { NAME_RE, decodeYaml, findWorkflow, getDefinition, listWorkflows, parseVersion, writeNoOverwrite } from './lib/workflows.mjs';
import { printJson, reportError, runIfMain } from './lib/cli.mjs';
import { assertInsideCwd, assertNotInSkillDir, skillDirOf } from './lib/paths.mjs';
import { scanSecrets } from './lib/validation.mjs';

const MAX_SECRET_PATHS = 20;
const MAX_SECRET_PATH_CHARS = 120;
const SKILL_DIR = skillDirOf(import.meta.url);
// Identifies this skill in the User-Agent of every NerdGraph request. Keep version equal to SKILL.md metadata.version
// (test/workflow-automation/client-version.test.mjs checks it).
export const CLIENT = { skill: 'fetch-workflow', version: '0.3.1' };

export { decodeYaml, listWorkflows };

const USAGE = `Usage: node fetch-workflow.mjs <command> [options]

Commands:
  env                       Show which NEW_RELIC_* variables are set (values never printed)
  list [--limit <n>] [--versions] [--account <id>]
                            List workflow definitions sorted by name: [{name, latestVersion}].
                            --versions adds every published version number: [{name, latestVersion, versions}].
                            --limit returns only the first n (the total is reported on stderr).
  get --name <name> [--version <n>] [--account <id>] [--out <path>] [--force]
                            Download one definition (latest version by default) as decoded YAML.
                            Default output: ./workflows/<name>.yaml. Refuses to overwrite without --force.

Environment:
  NEW_RELIC_API_KEY     User API key (required for list/get)
  NEW_RELIC_ACCOUNT_ID  Default account id (overridden by --account)
  NEW_RELIC_REGION      US (default), EU, or JP

Examples (run from the user's project directory; <skill-dir> is this skill's absolute path):
  node <skill-dir>/scripts/fetch-workflow.mjs list --account 1234567 --limit 20
  node <skill-dir>/scripts/fetch-workflow.mjs get --name example_workflow --account 1234567
  node <skill-dir>/scripts/fetch-workflow.mjs get --name example_workflow --version 3 --out workflows/example_workflow.v3.yaml

Exit codes: 0 ok, 1 usage error (including missing NEW_RELIC_API_KEY), 2 API error (including invalid key / HTTP 401/403) or not found.`;

export async function getWorkflow({ name, version, accountId, out, force, cwd }, config, opts) {
  if (!NAME_RE.test(name)) {
    throw new UsageError(`Invalid workflow name "${name}": must match ${NAME_RE}.`);
  }
  let resolvedName = name;
  let resolvedVersion = version;
  if (resolvedVersion === undefined) {
    const { match, caseVariants } = findWorkflow(await listWorkflows(accountId, config, opts), name);
    // Read-only, so a name that differs only in letter case resolves to the server's exact spelling.
    const found = match ?? caseVariants[0];
    if (!found) throw new ApiError(`Workflow "${name}" not found in account ${accountId}.`);
    resolvedName = found.name;
    resolvedVersion = found.latestVersion;
  }

  const { definition, yaml } = await getDefinition(accountId, resolvedName, resolvedVersion, config, opts);
  // The server's name builds the default output path, so it gets the same check as --name.
  if (typeof definition.name !== 'string' || !NAME_RE.test(definition.name)) {
    throw new ApiError(`NerdGraph returned an invalid workflow name ${JSON.stringify(definition.name)}: must match ${NAME_RE}.`);
  }

  const path = resolve(cwd, out ?? `workflows/${definition.name}.yaml`);
  if (out !== undefined) assertInsideCwd(path, cwd, '--out');
  writeNoOverwrite(path, yaml, force, cwd);
  const result = { name: definition.name, version: Number(definition.version), accountId, path, bytes: Buffer.byteLength(yaml) };
  const findings = scanSecrets(yaml) ?? [];
  const secrets = findings.filter((s) => s.ruleId !== 'secret-scan-truncated');
  const unscanned = findings.filter((s) => s.ruleId === 'secret-scan-truncated');
  const pathsOf = (list) => [...new Set(list.map((s) => s.path).filter(Boolean))].slice(0, MAX_SECRET_PATHS).map((p) => p.slice(0, MAX_SECRET_PATH_CHARS));
  if (unscanned.length > 0) {
    // Values longer than the scan cap were only partly checked, so a clean result does not cover them.
    result.secretScanTruncated = { count: unscanned.length, paths: pathsOf(unscanned) };
  }
  if (secrets.length > 0) {
    // Counts and locations only, never values. Paths contain key names from the fetched YAML, so they are capped.
    result.plaintextSecrets = { count: secrets.length, paths: pathsOf(secrets) };
    result.hint = 'The saved file appears to contain plaintext secrets. Do not commit or share it; replace each with ${{ :secrets:NAME }} before publishing.';
  }
  return result;
}

function parseLimit(raw) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new UsageError(`--limit must be a positive integer (got "${raw}").`);
  return Number(raw);
}

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), fetchImpl } = {}) {
  const opts = fetchImpl ? { fetchImpl } : {};
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        account: { type: 'string' },
        name: { type: 'string' },
        version: { type: 'string' },
        out: { type: 'string' },
        force: { type: 'boolean', default: false },
        limit: { type: 'string' },
        versions: { type: 'boolean' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    const [command] = positionals;
    if (values.help || !command) {
      (values.help ? stdout : stderr).write(`${USAGE}\n`);
      return values.help ? 0 : 1;
    }
    assertNotInSkillDir(cwd, SKILL_DIR);

    let result;
    if (command === 'env') {
      result = checkEnv(env);
    } else if (command === 'list' || command === 'get') {
      const config = getConfig(env, CLIENT);
      const accountId = resolveAccountId(values.account, config);
      if (command === 'list') {
        const limit = parseLimit(values.limit);
        result = await listWorkflows(accountId, config, opts);
        if (!values.versions) result = result.map(({ name, latestVersion }) => ({ name, latestVersion }));
        if (limit !== undefined && result.length > limit) {
          stderr.write(`Showing the first ${limit} of ${result.length} workflows (sorted by name).\n`);
          result = result.slice(0, limit);
        }
      } else {
        if (!values.name) throw new UsageError('get requires --name <workflow name>.');
        result = await getWorkflow(
          { name: values.name, version: parseVersion(values.version), accountId, out: values.out, force: values.force, cwd },
          config,
          opts,
        );
      }
    } else {
      throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
    }
    printJson(stdout, result);
    return 0;
  } catch (err) {
    return reportError(err, stderr);
  }
}

await runIfMain(import.meta.url, main);
