import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, UsageError } from '../../shared/workflow-automation/nerdgraph.mjs';
import { assertCommandFirst, exitCodeFor, printJson, reportError } from '../../shared/workflow-automation/cli.mjs';

const sink = () => ({ text: '', write(s) { this.text += s; } });

test('exitCodeFor: usage and flag errors are 1, everything else is 2', () => {
  assert.equal(exitCodeFor(new UsageError('x')), 1);
  assert.equal(exitCodeFor(Object.assign(new TypeError('Unknown option'), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' })), 1);
  assert.equal(exitCodeFor(new ApiError('x')), 2);
  assert.equal(exitCodeFor(new TypeError('boom')), 2);
});

test('reportError writes the message to stderr and returns the exit code', () => {
  const stderr = sink();
  assert.equal(reportError(new UsageError('bad flag'), stderr), 1);
  assert.equal(reportError(new ApiError('down'), stderr), 2);
  assert.equal(stderr.text, 'Error: bad flag\nError: down\n');
});

test('assertCommandFirst: the command must be argv[0], so options cannot precede it', () => {
  assertCommandFirst(['apply', 'f.yaml', '--expect', 'x'], 'apply', 's.mjs');
  for (const argv of [['--expect', 'x', 'apply', 'f.yaml'], ['--', 'apply', 'f.yaml'], ['--expect=apply', 'apply']]) {
    assert.throws(() => assertCommandFirst(argv, 'apply', 's.mjs'), (err) => err instanceof UsageError && /Put the command first: node s\.mjs apply/.test(err.message), argv.join(' '));
  }
});

test('printJson writes one compact line', () => {
  const stdout = sink();
  printJson(stdout, { a: [1, { b: 2 }] });
  assert.equal(stdout.text, '{"a":[1,{"b":2}]}\n');
});
