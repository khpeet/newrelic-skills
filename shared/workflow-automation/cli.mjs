// CLI plumbing shared by workflow-automation skill scripts: exit codes, error reporting, JSON output, entry-point guard.
// Source of truth: shared/workflow-automation/cli.mjs — run `npm run sync` after editing.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { UsageError } from './nerdgraph.mjs';
import { stripControlChars } from './text.mjs';

// 1 for usage errors (including bad flags), 2 for everything else (API errors, unexpected failures). Scripts add their own
// codes (3 validation or input errors, 4 failed runs) from results, not from thrown errors.
export const exitCodeFor = (err) => (err instanceof UsageError || err.code?.startsWith?.('ERR_PARSE_ARGS') ? 1 : 2);

// Messages can carry server or file text, so control characters (terminal escape sequences) are stripped before writing.
export function reportError(err, stderr) {
  stderr.write(`Error: ${stripControlChars(err?.message ?? err)}\n`);
  return exitCodeFor(err);
}

// Scripts with mutating commands (publish `apply`, run `start`) require the command as the first argument. parseArgs
// accepts options before it (`--expect X apply f.yaml`), but such a command line no longer contains the literal
// `<script>.mjs apply` that the README's permission `ask` rules match on.
export function assertCommandFirst(argv, command, script) {
  if (argv[0] !== command) throw new UsageError(`Put the command first: node ${script} ${command} [arguments] [options].`);
}

// One line of compact JSON: agents read this output, and indentation only costs tokens.
export const printJson = (stdout, result) => stdout.write(`${JSON.stringify(result)}\n`);

// Runs main(argv) only when the script is the entry point. realpath so the check still matches when the skill is
// installed through a symlink (npx skills).
export async function runIfMain(metaUrl, main) {
  const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
  if (metaUrl === pathToFileURL(invoked).href) process.exitCode = await main(process.argv.slice(2));
}
