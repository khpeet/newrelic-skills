#!/usr/bin/env node
// Validate a New Relic Workflow Automation definition: local YAML/schema/limit/secret/best-practice checks,
// then server-side validation via NerdGraph when credentials are set.
// Prints JSON to stdout, diagnostics to stderr. Never prompts.

import { parseArgs } from 'node:util';
import { checkSecretRef, readTarget, resolveTarget, validateAll, validateLocal, validateRemote } from './lib/validation.mjs';
import { printJson, reportError, runIfMain } from './lib/cli.mjs';
import { assertNotInSkillDir, skillDirOf } from './lib/paths.mjs';

const SKILL_DIR = skillDirOf(import.meta.url);
// Identifies this skill in the User-Agent of every NerdGraph request. Keep version equal to SKILL.md metadata.version
// (test/workflow-automation/client-version.test.mjs checks it).
export const CLIENT = { skill: 'validate-workflow', version: '0.3.1' };

export { checkSecretRef, resolveTarget, validateLocal, validateRemote };

const USAGE = `Usage: node validate-workflow.mjs <file-or-name> [options]
       node validate-workflow.mjs --stdin [options]

Target:
  <file-or-name>   A path (contains "/" or ends in .yaml/.yml), or a workflow name resolved in ./workflows/
                   by filename first, then by the top-level "name:" field (case-insensitive).
  --stdin          Read the YAML from stdin instead.

Options:
  --local-only     Skip server validation.
  --account <id>   Account for server validation (default NEW_RELIC_ACCOUNT_ID).
  -h, --help       Show this help.

Environment (server validation only; skipped with a warning when missing):
  NEW_RELIC_API_KEY     User API key
  NEW_RELIC_ACCOUNT_ID  Default account id
  NEW_RELIC_REGION      US (default), EU, or JP

Examples (run from the user's project directory; <skill-dir> is this skill's absolute path):
  node <skill-dir>/scripts/validate-workflow.mjs workflows/example_workflow.yaml
  node <skill-dir>/scripts/validate-workflow.mjs example_workflow --account 1234567
  node <skill-dir>/scripts/validate-workflow.mjs workflows/example_workflow.yaml --local-only

Exit codes: 0 valid, 1 usage error, 2 API/IO error, 3 validation errors found. A missing or invalid NEW_RELIC_API_KEY
(HTTP 401/403) does not fail: server validation is skipped with a server-skipped warning.`;

export async function main(argv, { env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), fetchImpl } = {}) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        stdin: { type: 'boolean', default: false },
        'local-only': { type: 'boolean', default: false },
        account: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    assertNotInSkillDir(cwd, SKILL_DIR);
    const { file, text } = await readTarget(values, positionals, stdin, cwd, USAGE);
    const { doc, relatedDocs, findings, server, summary } = await validateAll(text, { account: values.account, env, fetchImpl, client: CLIENT, localOnly: values['local-only'] });
    if (doc && !server.ran && !values['local-only']) {
      findings.push({ ruleId: 'server-skipped', severity: 'warning', category: 'server', message: `Server validation not performed: ${server.error}. Local checks do not cover step flow (next targets, loop jumps, duplicate step names) or the action catalog.` });
      summary.warnings += 1;
    }
    const result = { file, valid: summary.errors === 0, summary, findings, server, relatedDocs };
    printJson(stdout, result);
    return result.valid ? 0 : 3;
  } catch (err) {
    return reportError(err, stderr);
  }
}

await runIfMain(import.meta.url, main);
