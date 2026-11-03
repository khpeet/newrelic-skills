import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_BASE,
  extractSecrets,
  findActionPage,
  main,
  parseActionDocs,
  parseCatalogIndex,
} from '../../skills/workflow-automation/build-workflow/scripts/build-workflow.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'docs');
const fixture = (name) => readFileSync(join(FIXTURES, `${name}.md`), 'utf8');

const KEY = 'NRAK-SECRETKEY123';
const env = { NEW_RELIC_API_KEY: KEY, NEW_RELIC_ACCOUNT_ID: '1234' };

const LIVE_ACTIONS = [
  {
    name: 'http.get',
    version: 1,
    description: 'Perform an HTTP GET request',
    inputs: [
      { name: 'url', type: 'STRING', required: true, secretAllowed: false, example: 'https://example.com', validations: [] },
      { name: 'headers', type: 'MAP', required: false, secretAllowed: true, example: '{"Api-Key": "${{ :secrets:key }}"}', validations: [] },
      {
        name: 'format',
        type: 'STRING',
        required: false,
        secretAllowed: false,
        example: null,
        validations: [
          { __typename: 'WorkflowAutomationAllowedStringValuesValidation', errorMessage: 'Bad format', allowedStringValuesConstraint: ['JSON', 'CSV'] },
          { __typename: 'WorkflowAutomationRegexValidation', errorMessage: null, regexConstraint: '^[A-Z]+$' },
        ],
      },
      { name: 'selectors', type: 'LIST', required: false, secretAllowed: false, example: null, validations: [] },
    ],
    // The live catalog omits success/errorMessage; the docs list them.
    outputs: [{ name: 'statusCode' }, { name: 'responseBody' }],
    timeout: { action: 25 },
  },
  {
    name: 'slack.chat.postMessage',
    version: 1,
    description: 'Post a message to Slack',
    inputs: [
      { name: 'token', required: true, secretAllowed: true },
      { name: 'channel', required: true, secretAllowed: false },
      { name: 'text', required: true, secretAllowed: false },
      { name: 'attachment', required: false, secretAllowed: false },
    ],
    outputs: [{ name: 'threadTs' }, { name: 'success' }],
    timeout: { action: 20 },
  },
  { name: 'internal.only', version: 2, description: 'Not in docs', inputs: [], outputs: [], timeout: null },
];

// Routes NerdGraph POSTs to the live catalog and docs GETs to fixtures (missing fixture -> 404).
function fakeFetch(calls, { docsDown = false } = {}) {
  return async (url, init = {}) => {
    if (url.startsWith('https://api.')) {
      const { query, variables } = JSON.parse(init.body);
      calls.push({ url, query, variables });
      const body = { data: { actor: { account: { workflowAutomation: { actionDefinitions: { results: LIVE_ACTIONS } } } } } };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    calls.push({ url });
    if (docsDown) throw new Error('getaddrinfo ENOTFOUND docs.newrelic.com');
    const name = url.split('/').at(-1).replace(/\.md$/, '');
    if (!existsSync(join(FIXTURES, `${name}.md`))) return new Response('not found', { status: 404 });
    return new Response(fixture(name), { status: 200 });
  };
}

function capture() {
  return { text: '', write(s) { this.text += s; } };
}

let cwd;
let calls;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'build-wf-'));
  calls = [];
});

const run = async (argv, { fetchOpts, ...extra } = {}) => {
  const stdout = capture();
  const stderr = capture();
  const code = await main(argv, { env, stdout, stderr, cwd, fetchImpl: fakeFetch(calls, fetchOpts), ...extra });
  let json;
  try {
    json = JSON.parse(stdout.text);
  } catch {}
  return { code, stdout: stdout.text, stderr: stderr.text, json };
};

const YAML = `name: errorReport
description: Post the error count to Slack
workflowInputs:
  channel:
    type: String
steps:
  - name: countErrors
    type: action
    action: newrelic.nrdb.query
    version: 1
    inputs:
      query: SELECT count(*) FROM TransactionError SINCE 1 hour ago
  - name: eachResult
    type: loop
    for:
      in: \${{ .steps.countErrors.outputs.results }}
      steps:
        - name: notify
          type: action
          action: slack.chat.postMessage
          version: 1
          inputs:
            token: \${{ :secrets:slack:botToken }}
            channel: \${{ .workflowInputs.channel }}
            text: "Errors: \${{ .steps.eachResult.loop.element.count }}"
  - name: audit
    type: action
    action: http.post
    version: 1
    inputs:
      url: https://example.com/audit
      headers: '{"Api-Key": "\${{ :secrets:ACCOUNT:audit:apiKey }}", "X-Other": "\${{ :secrets:slack:botToken }}"}'
`;

const write = (argv, text = YAML) => run(['write', '--stdin', ...argv], { stdin: Readable.from([text]) });

// --- actions ---

test('actions lists live catalog sorted, with variables not interpolation', async () => {
  const { code, json } = await run(['actions', '--account', '999']);
  assert.equal(code, 0);
  assert.deepEqual(json.map((a) => a.name), ['http.get', 'internal.only', 'slack.chat.postMessage']);
  assert.deepEqual(Object.keys(json[0]), ['name', 'version']);
  assert.equal(calls[0].variables.accountId, 999);
  assert.ok(calls[0].query.includes('$accountId: Int!'));
  assert.ok(!calls[0].query.includes('999'));
});

test('actions --verbose adds descriptions', async () => {
  const { code, json } = await run(['actions', '--verbose']);
  assert.equal(code, 0);
  assert.deepEqual(Object.keys(json[0]), ['name', 'version', 'description']);
});

test('actions --search filters on name and description, case-insensitively', async () => {
  const byName = await run(['actions', '--search', 'SLACK']);
  assert.deepEqual(byName.json.map((a) => a.name), ['slack.chat.postMessage']);
  const byDescription = await run(['actions', '--search', 'get request']);
  assert.deepEqual(byDescription.json.map((a) => a.name), ['http.get']);
});

test('actions without an API key falls back to docs catalog pages', async () => {
  const { code, json } = await run(['actions', '--search', 'slack'], { env: {} });
  assert.equal(code, 0);
  assert.equal(json.source, 'docs');
  assert.deepEqual(json.pages.map((p) => p.title), ['Post a Slack message']);
  assert.ok(calls.every((c) => !c.url.startsWith('https://api.')));
});

test('actions with a key but no account id is a usage error', async () => {
  const { code, stderr } = await run(['actions'], { env: { NEW_RELIC_API_KEY: KEY } });
  assert.equal(code, 1);
  assert.match(stderr, /Account id required/);
});

// --- describe ---

test('describe merges live definition (types, examples, validations) with docs descriptions', async () => {
  const { code, json } = await run(['describe', 'http.get']);
  assert.equal(code, 0);
  assert.equal(json.source, 'live+docs');
  assert.equal(json.version, 1);
  assert.equal(json.timeoutSeconds, 25);
  assert.equal(json.docsUrl, `${CATALOG_BASE}http/http-get`);
  assert.deepEqual(json.inputs[0], {
    name: 'url',
    type: 'STRING',
    required: true,
    secretAllowed: false,
    example: 'https://example.com',
    description: json.inputs[0].description,
  });
  assert.match(json.inputs[0].description, /^Required\. The target URL/);
  assert.equal(json.inputs[1].secretAllowed, true);
  assert.deepEqual(json.inputs[2].validations, [
    { type: 'allowedStringValues', constraint: ['JSON', 'CSV'], errorMessage: 'Bad format' },
    { type: 'regex', constraint: '^[A-Z]+$' },
  ]);
  assert.equal(json.inputs[2].example, undefined);
  assert.ok(!json.inputs.some((i) => i.docsOnly), 'docs-only top-level inputs are not added');
  assert.deepEqual(json.outputs.map((o) => [o.name, o.type, Boolean(o.docsOnly)]), [
    ['statusCode', 'Int', false],
    ['responseBody', 'String', false],
    ['success', 'Boolean', true],
    ['errorMessage', 'String', true],
  ]);
  assert.deepEqual(json.warnings, []);
});

test('describe keeps nested docs-only sub-fields of live inputs', async () => {
  const { json } = await run(['describe', 'slack.chat.postMessage']);
  const nested = json.inputs.filter((i) => i.docsOnly).map((i) => i.name);
  assert.deepEqual(nested, ['attachment.filename', 'attachment.content']);
  assert.ok(!json.inputs.some((i) => i.name === 'selectors'), 'docs-only top-level inputs are not added');
});

test('describe returns live data with a warning when docs are unreachable', async () => {
  const { code, json } = await run(['describe', 'http.get'], { fetchOpts: { docsDown: true } });
  assert.equal(code, 0);
  assert.equal(json.source, 'live');
  assert.equal(json.inputs[0].type, 'STRING', 'live types survive without docs');
  assert.equal(json.inputs[0].description, undefined);
  assert.match(json.warnings[0], /ENOTFOUND/);
});

test('describe returns live data when the action has no docs page', async () => {
  const { code, json } = await run(['describe', 'internal.only']);
  assert.equal(code, 0);
  assert.equal(json.source, 'live');
  assert.match(json.warnings[0], /No docs page/);
});

test('describe truncates a long live input example', async () => {
  LIVE_ACTIONS.push({ name: 'long.example', version: 1, description: 'x', inputs: [{ name: 'body', type: 'STRING', required: false, secretAllowed: false, example: 'E'.repeat(2000), validations: [] }], outputs: [], timeout: null });
  try {
    const { json } = await run(['describe', 'long.example']);
    const example = json.inputs.find((i) => i.name === 'body').example;
    assert.ok(example.length <= 201, `example is ${example.length} chars`);
  } finally {
    LIVE_ACTIONS.pop();
  }
});

test('describe without an API key uses docs only', async () => {
  const { code, json } = await run(['describe', 'aws.ec2.describeInstances'], { env: {} });
  assert.equal(code, 0);
  assert.equal(json.source, 'docs');
  assert.equal(json.docsUrl, `${CATALOG_BASE}aws/ec2/aws-ec2`);
  assert.ok(json.inputs.some((i) => i.name === 'instanceIds'));
  assert.ok(!json.inputs.some((i) => i.name === 'imageId'), 'must not bleed in runInstances inputs');
  assert.ok(json.warnings.some((w) => /docs only/.test(w)));
});

test('describe warns when an action documented in docs is missing from the live catalog', async () => {
  const { code, json } = await run(['describe', 'utils.transform.toCSV']);
  assert.equal(code, 0);
  assert.equal(json.source, 'docs');
  assert.ok(json.warnings.some((w) => /not in the actionDefinitions catalog/.test(w)));
});

test('describe of an unknown action exits 2', async () => {
  const { code, stderr } = await run(['describe', 'bogus.thing']);
  assert.equal(code, 2);
  assert.match(stderr, /Action "bogus\.thing" not found/);
});

test('describe requires an action name', async () => {
  assert.equal((await run(['describe'])).code, 1);
});

// --- docs parsing ---

test('parseCatalogIndex strips anchors and deduplicates', () => {
  const pages = parseCatalogIndex(fixture('actions-catalog'));
  assert.ok(pages.some((p) => p.url === `${CATALOG_BASE}auth/auth-jwt-create`));
  assert.equal(new Set(pages.map((p) => p.url)).size, pages.length);
});

test('findActionPage matches action, group, and company-less slugs', () => {
  const pages = parseCatalogIndex(fixture('actions-catalog'));
  const slug = (a) => findActionPage(a, pages)?.url.split('/').at(-1);
  assert.equal(slug('http.get'), 'http-get');
  assert.equal(slug('aws.ec2.runInstances'), 'aws-ec2');
  assert.equal(slug('utils.transform.toCSV'), 'utils-transform');
  assert.equal(slug('utils.script.run'), 'script-run');
  assert.equal(slug('auth.jwt.create'), 'auth-jwt-create');
  assert.equal(slug('http.patch'), undefined);
});

test('parseActionDocs finds heading-anchored sections and tolerates malformed tables', () => {
  const parsed = parseActionDocs('utils.transform.toCSV', fixture('utils-transform'));
  assert.deepEqual(parsed.inputs.map((i) => [i.name, i.type, i.required]), [
    ['data', 'any', true],
    ['selectors', 'List', false],
  ]);
  assert.deepEqual(parsed.outputs.map((o) => o.name), ['csv', 'success', 'errorMessage']);
  assert.equal(parseActionDocs('utils.transform.toJSON', fixture('utils-transform')), null);
});

test('parseActionDocs uses the whole page when it is dedicated to an unnamed action', () => {
  const md = fixture('jira-issue-create');
  assert.equal(parseActionDocs('jira.issue.create', md), null);
  const parsed = parseActionDocs('jira.issue.create', md, { dedicated: true });
  assert.ok(parsed.inputs.some((i) => i.name === 'authToken' && i.required));
  assert.ok(parsed.outputs.some((o) => o.name === 'success'));
});

test('describe resolves an action from its dedicated docs page', async () => {
  const { code, json } = await run(['describe', 'jira.issue.create'], { env: {} });
  assert.equal(code, 0);
  assert.equal(json.docsUrl, `${CATALOG_BASE}jira/jira-issue-create`);
  assert.ok(json.inputs.some((i) => i.name === 'projectKey'));
});

test('parseActionDocs skips past an identifier mentioned in the page intro', () => {
  const autopilot = parseActionDocs('newrelic.autopilot.run', fixture('newrelic-autopilot'));
  assert.deepEqual(autopilot.inputs.map((i) => i.name), ['prompt', 'threadId', 'context', 'selectors']);
  assert.deepEqual(autopilot.outputs.map((o) => o.name), ['response', 'success', 'errorMessage']);
  const script = parseActionDocs('script.run', fixture('script-run'), { dedicated: true });
  assert.ok(script.inputs.some((i) => i.name === 'script' && i.required));
});

// --- write ---

test('write saves to ./workflows/<name>.yaml and reports actions and secrets', async () => {
  const { code, json } = await write([]);
  assert.equal(code, 0);
  assert.equal(json.path, join(cwd, 'workflows', 'errorReport.yaml'));
  assert.equal(readFileSync(json.path, 'utf8'), YAML);
  assert.deepEqual(json.actions, [
    { name: 'newrelic.nrdb.query', version: 1 },
    { name: 'slack.chat.postMessage', version: 1 },
    { name: 'http.post', version: 1 },
  ]);
  assert.deepEqual(json.secrets, [
    { ref: '${{ :secrets:slack:botToken }}', key: 'botToken', namespace: 'slack' },
    { ref: '${{ :secrets:ACCOUNT:audit:apiKey }}', key: 'apiKey', namespace: 'audit', scope: 'ACCOUNT' },
  ]);
});

test('write reports actions from nested loops too', async () => {
  const nested = YAML.replace('  - name: audit\n', `  - name: outer
    type: loop
    for:
      in: \${{ [1, 2] }}
      steps:
        - name: inner
          type: loop
          for:
            in: \${{ [3, 4] }}
            steps:
              - name: deep
                type: action
                action: newrelic.ingest.sendLogs
                version: 2
                inputs:
                  logs:
                    - message: hi
  - name: audit\n`);
  const { code, json } = await write([], nested);
  assert.equal(code, 0);
  assert.deepEqual(json.actions.map((a) => `${a.name}@${a.version}`), ['newrelic.nrdb.query@1', 'slack.chat.postMessage@1', 'newrelic.ingest.sendLogs@2', 'http.post@1']);
});

test('write --file on a directory is a usage error (exit 1), not a raw EISDIR', async () => {
  mkdirSync(join(cwd, 'adir'));
  const { code, stderr } = await run(['write', '--file', 'adir']);
  assert.equal(code, 1);
  assert.match(stderr, /Draft path is not a file/);
  assert.doesNotMatch(stderr, /EISDIR/);
});

test('write: an invalid-YAML error gives the reason and position, never a snippet of the file', async () => {
  writeFileSync(join(cwd, 'creds.txt'), 'AWS_SECRET_ACCESS_KEY: [leak-canary-12345\nline2: x\n');
  const { code, stderr } = await run(['write', '--file', 'creds.txt']);
  assert.equal(code, 1);
  assert.match(stderr, /Invalid YAML: .* \(line \d+, column \d+\)/);
  assert.doesNotMatch(stderr, /leak-canary|AWS_SECRET/);
});

test('write refuses to overwrite without --force', async () => {
  assert.equal((await write([])).code, 0);
  const again = await write([]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists/);
  const forced = await write(['--force'], YAML.replace('Post the error count', 'Updated'));
  assert.equal(forced.code, 0);
  assert.match(readFileSync(forced.json.path, 'utf8'), /Updated/);
});

test('write honors --out relative to cwd', async () => {
  const { json } = await write(['--out', 'drafts/x.yaml']);
  assert.equal(json.path, join(cwd, 'drafts', 'x.yaml'));
});

test('write rejects invalid YAML, a missing or unsafe name, and empty stdin', async () => {
  assert.match((await write([], 'name: [unclosed')).stderr, /Invalid YAML/);
  assert.equal((await write([], 'steps: []\n')).code, 1);
  assert.equal((await write([], 'name: ../escape\nsteps: []\n')).code, 1);
  assert.equal((await write([], '- a\n- b\n')).code, 1);
  assert.match((await write([], '  \n')).stderr, /No YAML/);
});

test('write requires exactly one of --file or --stdin', async () => {
  const none = await run(['write']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /exactly one of --file <draft> or --stdin/);
  writeFileSync(join(cwd, 'draft.yaml'), YAML);
  const both = await run(['write', '--stdin', '--file', 'draft.yaml'], { stdin: Readable.from([YAML]) });
  assert.equal(both.code, 1);
});

test('write --file saves the draft to ./workflows/<name>.yaml and leaves the draft untouched', async () => {
  const draft = join(cwd, 'tmp', 'draft-errorReport.yaml');
  mkdirSync(join(cwd, 'tmp'), { recursive: true });
  writeFileSync(draft, YAML);
  const { code, json } = await run(['write', '--file', draft]);
  assert.equal(code, 0);
  assert.equal(json.path, join(cwd, 'workflows', 'errorReport.yaml'));
  assert.equal(readFileSync(json.path, 'utf8'), YAML);
  assert.equal(readFileSync(draft, 'utf8'), YAML);
  const again = await run(['write', '--file', draft]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already exists/);
});

test('write --file reports a missing or empty draft', async () => {
  assert.match((await run(['write', '--file', 'nope.yaml'])).stderr, /Draft file not found/);
  writeFileSync(join(cwd, 'empty.yaml'), '\n');
  assert.match((await run(['write', '--file', 'empty.yaml'])).stderr, /Draft file is empty/);
});

test('write rejects anchors, aliases, merge keys, and multiple documents', async () => {
  const anchored = await write([], 'name: wf\nsteps:\n  - &s {name: a}\n  - *s\n');
  assert.equal(anchored.code, 1);
  assert.match(anchored.stderr, /Invalid YAML: YAML anchor "&s" is not supported/);
  assert.match((await write([], 'name: wf\nsteps:\n  - <<: {name: a}\n')).stderr, /merge key "<<"/);
  assert.match((await write([], 'name: wf\nsteps: []\n---\nname: b\n')).stderr, /exactly one YAML document, found 2/);
});

test('extractSecrets ignores comments and keys, finds refs in block scalars and JSON strings', () => {
  const text = [
    '# TODO use ${{ :secrets:OLD_KEY }} later',
    'name: wf',
    'a: ${{ :secrets:NS:real }} # was ${{ :secrets:NS:commented }}',
    'b: |',
    '  curl -H "k: ${{ :secrets:ACCOUNT:NS:inBlock }}"',
    'c: \'{"Api-Key": "${{ :secrets:inJson }}"}\'',
    '${{ :secrets:asKey }}: x',
    '',
  ].join('\n');
  assert.deepEqual(extractSecrets(text).map((s) => s.key), ['real', 'inBlock', 'inJson']);
  assert.deepEqual(extractSecrets('not: [valid\n# ${{ :secrets:raw }}').map((s) => s.key), ['raw']);
});

test('extractSecrets handles un-namespaced references', () => {
  assert.deepEqual(extractSecrets('a: ${{ :secrets:token }}'), [{ ref: '${{ :secrets:token }}', key: 'token' }]);
});

// --- general ---

test('env reports variables without values', async () => {
  const { json, stdout } = await run(['env']);
  assert.deepEqual(json, {
    NEW_RELIC_API_KEY: 'set',
    NEW_RELIC_ACCOUNT_ID: 'set',
    NEW_RELIC_REGION: 'missing',
    tmpDir: tmpdir(),
  });
  assert.ok(!stdout.includes(KEY));
});

test('API key never appears in output, even on errors', async () => {
  const failing = async () => new Response(`bad key ${KEY}`, { status: 500 });
  const results = [
    await run(['actions']),
    await run(['describe', 'http.get']),
    await run(['actions'], { fetchImpl: failing }),
  ];
  for (const { stdout, stderr } of results) {
    assert.ok(!stdout.includes(KEY) && !stderr.includes(KEY));
  }
  assert.equal(results[2].code, 2);
});

test('unknown command and no command are usage errors; --help exits 0', async () => {
  assert.equal((await run(['frobnicate'])).code, 1);
  assert.equal((await run([])).code, 1);
  assert.match((await run(['--help'])).stdout, /Usage:/);
});

