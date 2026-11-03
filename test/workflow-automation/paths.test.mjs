import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UsageError } from '../../shared/workflow-automation/nerdgraph.mjs';
import { assertNotInSkillDir, skillDirOf } from '../../shared/workflow-automation/paths.mjs';

const SKILLS = ['fetch', 'validate', 'build', 'publish', 'run'];
const skillsRoot = new URL('../../skills/workflow-automation/', import.meta.url);

function capture() {
  return { text: '', write(s) { this.text += s; } };
}

test('skillDirOf: the folder above scripts/', () => {
  assert.equal(skillDirOf(pathToFileURL('/opt/skills/fetch-workflow/scripts/fetch-workflow.mjs').href), '/opt/skills/fetch-workflow/');
});

test('assertNotInSkillDir: refuses the skill folder and its subfolders, allows everything else', () => {
  const root = mkdtempSync(join(tmpdir(), 'paths-'));
  const skill = join(root, 'fetch-workflow');
  mkdirSync(join(skill, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(root, 'fetch-workflow-copy'));
  mkdirSync(join(root, 'project'));

  for (const cwd of [skill, `${skill}/`, join(skill, 'scripts'), join(skill, 'scripts', 'lib')]) {
    assert.throws(() => assertNotInSkillDir(cwd, `${skill}/`), (err) => err instanceof UsageError && /Refusing to run inside the skill folder/.test(err.message));
  }
  for (const cwd of [root, join(root, 'project'), join(root, 'fetch-workflow-copy')]) {
    assert.doesNotThrow(() => assertNotInSkillDir(cwd, skill));
  }
});

test('assertNotInSkillDir: sees through symlinked installs', () => {
  const root = mkdtempSync(join(tmpdir(), 'paths-link-'));
  const canonical = join(root, 'canonical', 'run-workflow');
  mkdirSync(join(canonical, 'scripts'), { recursive: true });
  const link = join(root, 'agent-skills-run-workflow');
  symlinkSync(canonical, link, 'dir');
  assert.throws(() => assertNotInSkillDir(join(link, 'scripts'), canonical), UsageError);
  assert.throws(() => assertNotInSkillDir(canonical, link), UsageError);
});

test('assertNotInSkillDir: letter case does not bypass the guard on case-insensitive file systems', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'paths-case-'));
  const skill = join(root, 'Run-Workflow');
  mkdirSync(join(skill, 'scripts'), { recursive: true });
  if (!existsSync(join(root, 'run-workflow'))) return t.skip('case-sensitive file system');
  const lower = join(root, 'run-workflow');
  assert.throws(() => assertNotInSkillDir(join(lower, 'scripts'), skill), UsageError);
  assert.throws(() => assertNotInSkillDir(skill, join(lower, 'scripts', '..')), UsageError);
});

for (const skill of SKILLS) {
  test(`${skill}-workflow: refuses to run from its own skill folder, but --help still works`, async () => {
    const { main } = await import(new URL(`${skill}-workflow/scripts/${skill}-workflow.mjs`, skillsRoot));
    const skillDir = new URL(`${skill}-workflow/`, skillsRoot);
    const cwd = fileURLToPath(new URL('scripts/', skillDir));
    const fetchImpl = async () => assert.fail('no API call expected');
    const argv = skill === 'validate' ? ['--local-only', 'workflows/x.yaml'] : ['env'];

    const stdout = capture();
    const stderr = capture();
    assert.equal(await main(argv, { env: {}, stdout, stderr, cwd, fetchImpl }), 1);
    assert.equal(stdout.text, '');
    assert.match(stderr.text, /Refusing to run inside the skill folder .*Run the command from the user's project directory/);

    const help = capture();
    assert.equal(await main(['--help'], { env: {}, stdout: help, stderr: capture(), cwd, fetchImpl }), 0);
    assert.match(help.text, /^Usage:/);
  });
}
