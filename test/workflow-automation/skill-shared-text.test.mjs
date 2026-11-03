import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const FAMILY_DIR = new URL('../../skills/workflow-automation/', import.meta.url);
const SKILLS = readdirSync(FAMILY_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(new URL(`${e.name}/SKILL.md`, FAMILY_DIR)))
  .map((e) => e.name)
  .sort();
const read = (skill) => readFileSync(new URL(`${skill}/SKILL.md`, FAMILY_DIR), 'utf8');
const hasScripts = (skill) => {
  const dir = new URL(`${skill}/scripts/`, FAMILY_DIR);
  return existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.mjs'));
};

// Skills are self-contained, so these rules are copied into every SKILL.md that has scripts. This keeps the copies from
// drifting apart: change the wording in all of those files at once. A skill without scripts needs none of them, but any
// that it does carry must match.
const SHARED = [
  '**Where to run:**',
  '**Run each script as one plain command.**',
  '**Never resolve ambiguity yourself.**',
  '- Never ask the user to paste an API key',
  '- The account id is not a secret',
];

const paragraphOf = (text, start) => {
  const from = text.indexOf(start);
  if (from === -1) return null;
  const end = text.indexOf('\n', from);
  return text.slice(from, end === -1 ? undefined : end);
};

test('skills are discovered, and at least one has scripts', () => {
  assert.ok(SKILLS.length > 0, 'no skills found under skills/workflow-automation');
  assert.ok(SKILLS.some(hasScripts), 'no skill with scripts found: the shared-text checks would be vacuous');
});

for (const start of SHARED) {
  test(`SKILL.md files share identical text for "${start}"`, () => {
    const found = [];
    for (const skill of SKILLS) {
      const text = paragraphOf(read(skill), start);
      if (text === null) assert.ok(!hasScripts(skill), `${skill} has scripts but its SKILL.md is missing "${start}"`);
      else found.push([skill, text]);
    }
    for (const [skill, text] of found) assert.equal(text, found[0][1], `${skill} differs from ${found[0][0]}`);
  });
}
