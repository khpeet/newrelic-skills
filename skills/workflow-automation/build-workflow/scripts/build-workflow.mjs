#!/usr/bin/env node
// Helpers for authoring New Relic Workflow Automation definitions: look up actions in the live
// actionDefinitions catalog (enriched from the docs actions catalog) and save drafted YAML.
// Prints JSON to stdout, diagnostics to stderr. Never prompts.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ApiError, UsageError, checkEnv, getConfig, nerdgraph, resolveAccountId } from './lib/nerdgraph.mjs';
import { NAME_RE, readStream, writeNoOverwrite } from './lib/workflows.mjs';
import { printJson, reportError, runIfMain } from './lib/cli.mjs';
import { assertInsideCwd, assertNotInSkillDir, skillDirOf } from './lib/paths.mjs';
import { collectSteps } from './lib/steps.mjs';
import { MAX_DESCRIPTION_CHARS, MAX_UNTRUSTED_CHARS, truncate } from './lib/text.mjs';
import { parseYaml } from './lib/yaml.mjs';

const SKILL_DIR = skillDirOf(import.meta.url);
// Identifies this skill in the User-Agent of every NerdGraph request. Keep version equal to SKILL.md metadata.version
// (test/workflow-automation/client-version.test.mjs checks it).
export const CLIENT = { skill: 'build-workflow', version: '0.6.0' };

const USAGE = `Usage: node build-workflow.mjs <command> [options]

Commands:
  env                       Show which NEW_RELIC_* variables are set (values never printed) and the temp dir for drafts
  actions [--search <term>] [--verbose] [--account <id>]
                            List actions from the live actionDefinitions catalog: [{name, version}], plus
                            description with --verbose. --search matches names and descriptions.
                            Without NEW_RELIC_API_KEY, lists docs actions catalog pages instead.
  describe <action> [--account <id>]
                            Show one action's version, inputs, and outputs, merging the live definition
                            (required, secretAllowed) with types and descriptions from its docs page.
  write (--file <draft> | --stdin) [--out <path>] [--force]
                            Save drafted YAML read from a draft file (preferred) or stdin. Default output:
                            ./workflows/<name>.yaml. Refuses to overwrite without --force. Reports actions and
                            secret references used. The draft file itself is never modified.

Environment:
  NEW_RELIC_API_KEY     User API key (optional for actions/describe: docs-only without it)
  NEW_RELIC_ACCOUNT_ID  Default account id (overridden by --account)
  NEW_RELIC_REGION      US (default), EU, or JP

Examples (run from the user's project directory; <skill-dir> is this skill's absolute path):
  node <skill-dir>/scripts/build-workflow.mjs actions --search slack
  node <skill-dir>/scripts/build-workflow.mjs describe http.get
  node <skill-dir>/scripts/build-workflow.mjs write --file /tmp/example_workflow.draft.yaml

Exit codes: 0 ok, 1 usage error or invalid YAML, 2 API/network error (including invalid key / HTTP 401/403) or action
not found. Without NEW_RELIC_API_KEY, actions/describe fall back to the docs instead of failing.`;

export const CATALOG_BASE = 'https://docs.newrelic.com/docs/workflow-automation/setup-and-configure/actions-catalog/';
const CATALOG_INDEX = `${CATALOG_BASE}actions-catalog.md`;
const DOCS_TIMEOUT_MS = 30_000;
// Headings inside a single action's section, not the start of another action.
const SUBSECTION = /^(inputs|outputs|examples?|selectors|prerequisites)\b/i;
const SECRET_REF = /\$\{\{\s*:secrets:([^}\s]+)\s*\}\}/g;

// actionDefinitions returns the full list of actions available for the given account.
const ACTIONS_QUERY = `query ActionDefinitions($accountId: Int!) {
  actor { account(id: $accountId) { workflowAutomation {
    actionDefinitions { results {
      name version description
      inputs {
        name type required secretAllowed example
        validations {
          __typename
          ... on WorkflowAutomationAllowedStringValuesValidation { errorMessage allowedStringValuesConstraint }
          ... on WorkflowAutomationMaxIntegerValueValidation { errorMessage maxIntegerValueConstraint }
          ... on WorkflowAutomationMinIntegerValueValidation { errorMessage minIntegerValueConstraint }
          ... on WorkflowAutomationMaxLengthValidation { errorMessage maxLengthConstraint }
          ... on WorkflowAutomationMinLengthValidation { errorMessage minLengthConstraint }
          ... on WorkflowAutomationRegexValidation { errorMessage regexConstraint }
        }
      }
      outputs { name }
      timeout { action }
    } }
  } } }
}`;

// Flattens the validation union, e.g. WorkflowAutomationRegexValidation -> {type: "regex", constraint, errorMessage}.
function normalizeValidation(v) {
  const constraintKey = Object.keys(v).find((k) => k.endsWith('Constraint'));
  const type = (v.__typename ?? '').replace(/^WorkflowAutomation/, '').replace(/Validation$/, '');
  const result = { type: type.charAt(0).toLowerCase() + type.slice(1) };
  if (constraintKey) result.constraint = v[constraintKey];
  if (v.errorMessage) result.errorMessage = truncate(v.errorMessage, MAX_UNTRUSTED_CHARS);
  return result;
}

export async function listLiveActions(accountId, config, opts) {
  const data = await nerdgraph(ACTIONS_QUERY, { accountId }, config, opts);
  return data?.actor?.account?.workflowAutomation?.actionDefinitions?.results ?? [];
}

function matches(term, ...fields) {
  if (!term) return true;
  const needle = term.toLowerCase();
  return fields.some((f) => String(f ?? '').toLowerCase().includes(needle));
}

// --- Docs actions catalog -------------------------------------------------------------------

async function fetchDocs(url, { fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOCS_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'text/markdown' }, signal: controller.signal });
    if (!response.ok) throw new ApiError(`Docs request ${url} returned HTTP ${response.status}.`);
    return await response.text();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    const reason = err.name === 'AbortError' ? `timed out after ${DOCS_TIMEOUT_MS} ms` : err.message;
    throw new ApiError(`Docs request ${url} failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

// Child pages linked from the catalog index: [{title, url}], anchors stripped, deduplicated.
export function parseCatalogIndex(markdown) {
  const pages = new Map();
  const link = /\[\*{0,2}([^\]]+?)\*{0,2}\]\((https:\/\/docs\.newrelic\.com\/docs\/workflow-automation\/setup-and-configure\/actions-catalog\/[^)#\s]+)(?:#[^)]*)?\)/g;
  for (const [, title, url] of markdown.matchAll(link)) {
    if (!pages.has(url)) pages.set(url, { title: title.trim(), url });
  }
  return [...pages.values()];
}

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Pages are named after the action (http-get), its group (aws-ec2, newrelic-nrdb), or the action
// without its leading company segment (utils.script.run -> script-run). Prefer the longest match.
export function findActionPage(action, pages) {
  const segments = action.split('.');
  const bySlug = new Map(pages.map((p) => [squash(p.url.split('/').at(-1)), p]));
  for (const start of [0, 1]) {
    for (let end = segments.length; end - start >= 2; end--) {
      const page = bySlug.get(squash(segments.slice(start, end).join('')));
      if (page) return page;
    }
  }
  return undefined;
}

function splitRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

const cleanCell = (cell) => cell.replace(/\*\*/g, '').replace(/`/g, '').trim();

// Parses every Markdown table whose header starts with Input/Output/Field into rows.
function parseTables(section) {
  const tables = [];
  const lines = section.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith('|') || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) continue;
    const header = splitRow(lines[i]).map((h) => cleanCell(h).toLowerCase());
    const kind = /^input/.test(header[0]) ? 'inputs' : /^(output|field)/.test(header[0]) ? 'outputs' : null;
    let j = i + 2;
    const rows = [];
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) rows.push(splitRow(lines[j]));
    if (kind) tables.push({ kind, header, rows });
    i = j - 1;
  }
  return tables;
}

function rowToField(header, row) {
  const col = (re) => header.findIndex((h) => re.test(h));
  const typeCol = col(/^(type|datatype)$/);
  const descCol = col(/^description$/);
  const name = cleanCell(row[0] ?? '');
  if (!name) return null;
  const field = { name };
  const type = typeCol >= 0 ? cleanCell(row[typeCol] ?? '') : '';
  if (type) field.type = type;
  const description = descCol >= 0 ? cleanCell(row[descCol] ?? '') : '';
  if (description) {
    if (/^required\b/i.test(description)) field.required = true;
    else if (/^optional\b/i.test(description)) field.required = false;
    field.description = truncate(description, MAX_DESCRIPTION_CHARS);
  }
  return field;
}

// Locates the action's section on a page (pages may document many actions) and parses its tables.
// A page dedicated to the action (slug equals the action name) may never name it, so the whole page is used.
export function parseActionDocs(action, markdown, { dedicated = false } = {}) {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, '');
  const lastSegment = action.split('.').at(-1).toLowerCase();
  let at = body.indexOf(`\`${action}\``);
  if (at < 0) {
    // Some pages only tag the heading, e.g. "## Convert to CSV [#utils-transform-toCSV]".
    const anchor = [...body.matchAll(/^#{2,3} .*\[#([^\]]+)\]/gm)].find((m) => m[1].toLowerCase().endsWith(lastSegment));
    at = anchor?.index ?? -1;
  }
  if (at < 0 && !dedicated) return null;

  const empty = (r) => !r.inputs.length && !r.outputs.length;
  let result = { inputs: [], outputs: [] };
  if (at >= 0) {
    const headings = [...body.matchAll(/^## (.*)$/gm)].filter((m) => !SUBSECTION.test(m[1]));
    const before = headings.filter((m) => m.index <= at).at(-1);
    const after = headings.filter((m) => m.index > at);
    result = fieldsFrom(body.slice(before?.index ?? 0, after[0]?.index ?? body.length));
    // An identifier in the page intro sits above the section that holds the tables.
    if (empty(result) && !before && after[0]) result = fieldsFrom(body.slice(after[0].index, after[1]?.index ?? body.length));
  }
  if (empty(result) && dedicated) result = fieldsFrom(body);
  return result;
}

function fieldsFrom(section) {
  const result = { inputs: [], outputs: [] };
  for (const { kind, header, rows } of parseTables(section)) {
    for (const row of rows) {
      const field = rowToField(header, row);
      if (field) result[kind].push(field);
    }
  }
  return result;
}

async function docsCatalog(opts) {
  return parseCatalogIndex(await fetchDocs(CATALOG_INDEX, opts));
}

async function docsForAction(action, opts) {
  const page = findActionPage(action, await docsCatalog(opts));
  if (!page) return { warning: `No docs page found for "${action}" in the actions catalog.` };
  const dedicated = squash(page.url.split('/').at(-1)) === squash(action);
  const parsed = parseActionDocs(action, await fetchDocs(`${page.url}.md`, opts), { dedicated });
  if (!parsed) return { docsUrl: page.url, warning: `"${action}" is not documented on ${page.url}.` };
  const warning = parsed.inputs.length || parsed.outputs.length ? undefined : `Could not parse input/output tables on ${page.url}.`;
  return { docsUrl: page.url, ...parsed, warning };
}

// --- Commands -------------------------------------------------------------------------------

function liveConfig(env, account) {
  if (!env.NEW_RELIC_API_KEY) return null;
  const config = getConfig(env, CLIENT);
  return { config, accountId: resolveAccountId(account, config) };
}

// Compact by default (name, version): the full catalog with descriptions is large enough to be truncated.
export async function listActions({ search, live, verbose = false }, opts) {
  if (live) {
    const actions = await listLiveActions(live.accountId, live.config, opts);
    return actions
      .filter((a) => matches(search, a.name, a.description))
      .map(({ name, version, description }) => (verbose ? { name, version, description: truncate(description, MAX_DESCRIPTION_CHARS) } : { name, version }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const pages = await docsCatalog(opts);
  return {
    source: 'docs',
    note: 'NEW_RELIC_API_KEY is not set: these are docs catalog pages, not account-specific action names. Use describe <action> for details.',
    pages: pages.filter((p) => matches(search, p.title, p.url)),
  };
}

// Live fields are authoritative (name, type, required, secretAllowed, example, validations); docs add descriptions,
// and a type only where the live catalog has none (outputs).
function mergeFields(liveFields = [], docFields = [], { input }) {
  const docsByName = new Map(docFields.map((f) => [f.name, f]));
  const merged = liveFields.map((l) => {
    const d = docsByName.get(l.name) ?? {};
    docsByName.delete(l.name);
    const field = { name: l.name };
    const type = l.type ?? d.type;
    if (type) field.type = type;
    if (input) {
      field.required = Boolean(l.required);
      field.secretAllowed = Boolean(l.secretAllowed);
      if (l.example) field.example = truncate(l.example);
      if (l.validations?.length) field.validations = l.validations.map(normalizeValidation);
    }
    if (d.description) field.description = d.description;
    return field;
  });
  for (const d of docsByName.values()) {
    // Nested docs-only rows (e.g. attachment.filename) document sub-fields of live inputs. A plural live list
    // (attachments) is documented by singular rows (attachment.type), so its singular prefix counts too. The live
    // catalog omits the common success/errorMessage outputs that the docs list, so docs-only outputs are kept too.
    const documents = (f) => d.name.startsWith(`${f.name}.`) || (f.name.endsWith('s') && d.name.startsWith(`${f.name.slice(0, -1)}.`));
    if (!input || merged.some(documents)) merged.push({ ...d, docsOnly: true });
  }
  return merged;
}

export async function describeAction({ action, live }, opts) {
  const warnings = [];
  let definition;
  if (live) {
    const actions = await listLiveActions(live.accountId, live.config, opts);
    definition = actions.find((a) => a.name === action) ?? actions.find((a) => a.name.toLowerCase() === action.toLowerCase());
    if (!definition) warnings.push(`"${action}" is not in the actionDefinitions catalog for account ${live.accountId}.`);
  }

  let docs = {};
  try {
    docs = await docsForAction(definition?.name ?? action, opts);
  } catch (err) {
    docs = { warning: err.message };
  }
  if (docs.warning) warnings.push(docs.warning);

  if (definition) {
    return {
      name: definition.name,
      version: definition.version,
      source: docs.inputs?.length || docs.outputs?.length ? 'live+docs' : 'live',
      ...(definition.description && { description: truncate(definition.description, MAX_DESCRIPTION_CHARS) }),
      ...(docs.docsUrl && { docsUrl: docs.docsUrl }),
      ...(definition.timeout?.action !== undefined && { timeoutSeconds: definition.timeout.action }),
      inputs: mergeFields(definition.inputs, docs.inputs, { input: true }),
      outputs: mergeFields(definition.outputs, docs.outputs, { input: false }),
      warnings,
    };
  }
  if (docs.inputs?.length || docs.outputs?.length) {
    if (!live) warnings.push('NEW_RELIC_API_KEY is not set: details come from docs only; the version is assumed to be 1.');
    return { name: action, version: 1, source: 'docs', docsUrl: docs.docsUrl, inputs: docs.inputs, outputs: docs.outputs, warnings };
  }
  throw new ApiError(`Action "${action}" not found. ${warnings.join(' ')}`.trim());
}

// Secret references in string values, deduplicated: :secrets:KEY, :NAMESPACE:KEY, or :SCOPE:NAMESPACE:KEY. Comments and
// mapping keys are not scanned.
function secretsInDoc(doc) {
  const seen = new Map();
  const visit = (value) => {
    if (typeof value === 'string') {
      for (const [ref, path] of value.matchAll(SECRET_REF)) {
        const parts = path.split(':');
        const secret = { ref: ref.replace(/\s+/g, ' '), key: parts.at(-1) };
        if (parts.length >= 2) secret.namespace = parts.at(-2);
        if (parts.length >= 3) secret.scope = parts.at(-3);
        if (!seen.has(path)) seen.set(path, secret);
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  visit(doc);
  return [...seen.values()];
}

// Text that does not parse as YAML falls back to a scan of the raw text.
export function extractSecrets(text) {
  let docs;
  try {
    docs = parseYaml(text);
  } catch {
    docs = [text];
  }
  return secretsInDoc(docs);
}

// Distinct actions (name@version) in document order, including those inside loops.
function collectActions(steps) {
  const out = new Map();
  for (const { step } of collectSteps(steps)) {
    if (step?.type === 'action' && step.action) out.set(`${step.action}@${step.version}`, { name: step.action, version: step.version });
  }
  return out;
}

// The draft comes from exactly one of --file (written by the agent's file tool, no shell quoting) or --stdin.
async function readDraft(values, stdin, cwd) {
  if (Boolean(values.stdin) === (values.file !== undefined)) {
    throw new UsageError('write requires exactly one of --file <draft> or --stdin.');
  }
  if (values.file !== undefined) {
    const path = resolve(cwd, values.file);
    if (!existsSync(path)) throw new UsageError(`Draft file not found: ${path}`);
    if (!statSync(path).isFile()) throw new UsageError(`Draft path is not a file: ${path}`);
    const text = readFileSync(path, 'utf8');
    if (!text.trim()) throw new UsageError(`Draft file is empty: ${path}`);
    return text;
  }
  const text = await readStream(stdin);
  if (!text.trim()) throw new UsageError('No YAML received on stdin.');
  return text;
}

export function writeWorkflow({ text, out, force, cwd }) {
  let documents;
  try {
    documents = parseYaml(text);
  } catch (err) {
    // js-yaml's err.message ends with a snippet of the text around the error; the draft file can be any path, so give only
    // the reason and position (the same fields validate-workflow reports). YamlFeatureError has no reason, and its message is fixed text.
    const where = err.mark ? ` (line ${err.mark.line + 1}, column ${err.mark.column + 1})` : '';
    throw new UsageError(`Invalid YAML: ${err.reason || err.message}${where}`);
  }
  if (documents.length !== 1) throw new UsageError(`Invalid YAML: expected exactly one YAML document, found ${documents.length}.`);
  const [doc] = documents;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new UsageError('YAML must be a mapping with top-level name and steps.');
  if (typeof doc.name !== 'string' || !NAME_RE.test(doc.name)) {
    throw new UsageError(`Top-level name is missing or invalid: it must match ${NAME_RE}.`);
  }
  const content = text.endsWith('\n') ? text : `${text}\n`;
  const path = resolve(cwd, out ?? `workflows/${doc.name}.yaml`);
  if (out !== undefined) assertInsideCwd(path, cwd, '--out');
  writeNoOverwrite(path, content, force, cwd);
  return {
    name: doc.name,
    path,
    bytes: Buffer.byteLength(content),
    actions: [...collectActions(doc.steps).values()],
    secrets: secretsInDoc(doc),
  };
}

export async function main(
  argv,
  { env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, cwd = process.cwd(), fetchImpl } = {},
) {
  const opts = fetchImpl ? { fetchImpl } : {};
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        account: { type: 'string' },
        search: { type: 'string' },
        out: { type: 'string' },
        stdin: { type: 'boolean', default: false },
        file: { type: 'string' },
        verbose: { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    const [command, arg] = positionals;
    if (values.help || !command) {
      (values.help ? stdout : stderr).write(`${USAGE}\n`);
      return values.help ? 0 : 1;
    }
    assertNotInSkillDir(cwd, SKILL_DIR);

    let result;
    if (command === 'env') {
      result = { ...checkEnv(env), tmpDir: tmpdir() };
    } else if (command === 'actions') {
      result = await listActions({ search: values.search, verbose: values.verbose, live: liveConfig(env, values.account) }, opts);
    } else if (command === 'describe') {
      if (!arg) throw new UsageError('describe requires an action name, e.g. describe http.get.');
      result = await describeAction({ action: arg, live: liveConfig(env, values.account) }, opts);
    } else if (command === 'write') {
      const text = await readDraft(values, stdin, cwd);
      result = writeWorkflow({ text, out: values.out, force: values.force, cwd });
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
