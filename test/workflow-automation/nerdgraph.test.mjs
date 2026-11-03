import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiError,
  UsageError,
  checkEnv,
  getConfig,
  nerdgraph,
  resolveAccountId,
} from '../../shared/workflow-automation/nerdgraph.mjs';

const KEY = 'NRAK-SECRETKEY123';
const config = getConfig({ NEW_RELIC_API_KEY: KEY });

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('checkEnv reports presence without values', () => {
  const result = checkEnv({ NEW_RELIC_API_KEY: KEY, NEW_RELIC_REGION: 'EU' });
  assert.deepEqual(result, { NEW_RELIC_API_KEY: 'set', NEW_RELIC_ACCOUNT_ID: 'missing', NEW_RELIC_REGION: 'set' });
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('getConfig requires api key and validates region', () => {
  assert.throws(() => getConfig({}), UsageError);
  assert.throws(() => getConfig({ NEW_RELIC_API_KEY: KEY, NEW_RELIC_REGION: 'MARS' }), /NEW_RELIC_REGION/);
  assert.equal(getConfig({ NEW_RELIC_API_KEY: KEY, NEW_RELIC_REGION: 'eu' }).endpoint, 'https://api.eu.newrelic.com/graphql');
  assert.equal(config.endpoint, 'https://api.newrelic.com/graphql');
});

test('resolveAccountId prefers flag, falls back to env, rejects non-numeric', () => {
  assert.equal(resolveAccountId('42', { accountId: '7' }), 42);
  assert.equal(resolveAccountId(undefined, { accountId: '7' }), 7);
  assert.throws(() => resolveAccountId(undefined, {}), UsageError);
  assert.throws(() => resolveAccountId('12; drop', {}), UsageError);
});

test('nerdgraph sends key header and variables, returns data', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return jsonResponse({ data: { ok: true } });
  };
  const data = await nerdgraph('query Q($a: Int!) { x }', { a: 1 }, config, { fetchImpl });
  assert.deepEqual(data, { ok: true });
  assert.equal(captured.init.headers['API-Key'], KEY);
  assert.deepEqual(JSON.parse(captured.init.body).variables, { a: 1 });
});

test('nerdgraph identifies the calling skill in the User-Agent, with a family fallback', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers['User-Agent']);
    return jsonResponse({ data: { ok: true } });
  };
  const client = { skill: 'publish-workflow', version: '1.2.3' };
  await nerdgraph('q', {}, getConfig({ NEW_RELIC_API_KEY: KEY }, client), { fetchImpl });
  await nerdgraph('q', {}, config, { fetchImpl });
  await nerdgraph('q', {}, { ...config, userAgent: undefined }, { fetchImpl });
  assert.deepEqual(seen, ['newrelic-skills/1.2.3 (workflow-automation/publish-workflow)', 'newrelic-skills (workflow-automation)', 'newrelic-skills (workflow-automation)']);
});

test('nerdgraph surfaces GraphQL errors and redacts key', async () => {
  const fetchImpl = async () => jsonResponse({ errors: [{ message: `bad key ${KEY}` }] });
  await assert.rejects(nerdgraph('q', {}, config, { fetchImpl }), (err) => {
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /bad key \[REDACTED\]/);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
});

test('nerdgraph maps 401/403 to auth hint', async () => {
  const fetchImpl = async () => new Response('nope', { status: 401 });
  await assert.rejects(nerdgraph('q', {}, config, { fetchImpl }), /User API key is invalid/);
});

test('nerdgraph never follows redirects', async () => {
  let init;
  const fetchImpl = async (url, options) => {
    init = options;
    return new Response(null, { status: 307, headers: { Location: `https://collector.example.net/graphql?key=${KEY}&a=1` } });
  };
  await assert.rejects(nerdgraph('q', {}, config, { fetchImpl }), (err) => {
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /HTTP 307 redirecting to collector\.example\.net; not following it/);
    assert.ok(!err.message.includes('?') && !err.message.includes(KEY));
    return true;
  });
  assert.equal(init.redirect, 'manual');
});

test('nerdgraph redirect errors cope with a missing or relative Location', async () => {
  const noLocation = async () => new Response(null, { status: 302 });
  await assert.rejects(nerdgraph('q', {}, config, { fetchImpl: noLocation }), /HTTP 302 redirecting to an unspecified location/);
  const relative = async () => new Response(null, { status: 308, headers: { Location: '/elsewhere?x=1' } });
  await assert.rejects(nerdgraph('q', {}, config, { fetchImpl: relative }), /HTTP 308 redirecting to api\.newrelic\.com;/);
});

test('nerdgraph times out', async () => {
  const fetchImpl = (url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(nerdgraph('q', {}, config, { fetchImpl, timeoutMs: 10 }), /timed out after 10 ms/);
});

test('nerdgraph times out when the response body stalls after the headers', async () => {
  const fetchImpl = async (url, { signal }) => ({
    status: 200,
    ok: true,
    text: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  await assert.rejects(nerdgraph('q', {}, config, { fetchImpl, timeoutMs: 10 }), (err) => err instanceof ApiError && /NerdGraph request failed: timed out after 10 ms/.test(err.message));
});

test('nerdgraph reports a body read failure as an ApiError without the key', async () => {
  const fetchImpl = async () => ({ status: 200, ok: true, text: async () => { throw new TypeError(`terminated near ${KEY}`); } });
  await assert.rejects(nerdgraph('q', {}, config, { fetchImpl }), (err) => {
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /NerdGraph request failed: terminated/);
    assert.ok(!err.message.includes(KEY));
    return true;
  });
});

test('nerdgraph exposes GraphQL error classes next to the messages', async () => {
  const body = { errors: [{ message: 'a', extensions: { errorClass: 'ACCESS_DENIED' } }, { message: 'b' }] };
  const fetchImpl = async () => new Response(JSON.stringify(body), { status: 200 });
  await assert.rejects(nerdgraph('q', {}, config, { fetchImpl }), (err) => {
    assert.deepEqual(err.graphqlErrors, ['a', 'b']);
    assert.deepEqual(err.graphqlErrorClasses, ['ACCESS_DENIED', undefined]);
    return true;
  });
});

test('getConfig refuses a key that is not a valid header value, without echoing it', () => {
  for (const key of [' NRAK-LEAKCANARY', 'NRAK-LEAKCANARY\n', 'NRAK-LEAK\u0000CANARY', 'NRAK-LEAKÇANARY', 'NRAK LEAKCANARY']) {
    assert.throws(
      () => getConfig({ NEW_RELIC_API_KEY: key }),
      (err) => err instanceof UsageError && /cannot be sent as a request header/.test(err.message) && !err.message.includes('LEAK'),
    );
  }
});

test('nerdgraph redacts the trimmed key too when fetch rejects a hand-built config', async () => {
  const bad = { ...config, apiKey: ' NRAK-LEAKCANARY1234\u0000x' };
  await assert.rejects(
    () => nerdgraph('query { a }', {}, bad),
    (err) => err instanceof ApiError && !err.message.includes('LEAKCANARY'),
  );
});
