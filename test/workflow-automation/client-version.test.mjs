import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from '../../shared/workflow-automation/js-yaml.mjs';

// Each script's CLIENT feeds the NerdGraph User-Agent; its version must track SKILL.md metadata.version.
const SKILLS = ['fetch-workflow', 'validate-workflow', 'build-workflow', 'publish-workflow', 'run-workflow'];

for (const skill of SKILLS) {
  test(`${skill}: CLIENT matches the folder name and SKILL.md metadata.version`, async () => {
    const dir = new URL(`../../skills/workflow-automation/${skill}/`, import.meta.url);
    const { CLIENT } = await import(new URL(`scripts/${skill}.mjs`, dir));
    const text = readFileSync(new URL('SKILL.md', dir), 'utf8');
    const meta = load(text.match(/^---\n([\s\S]*?)\n---/)[1]);
    assert.deepEqual(CLIENT, { skill, version: meta.metadata.version });
  });
}
