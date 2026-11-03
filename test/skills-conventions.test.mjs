// Repo conventions every skills/<family>/<skill>/ must follow, whatever its family and whether or not it has scripts.
// These are on top of the Agent Skills specification, which test/skills-frontmatter.test.mjs checks. Offline, no dependencies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dirs = (dir) => readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const skills = dirs(join(root, 'skills')).flatMap((family) =>
  dirs(join(root, 'skills', family)).map((name) => ({ family, name, dir: join(root, 'skills', family, name) })),
);
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;
const field = (text, key) => text.match(FRONTMATTER)?.[1].match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1] ?? '';
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

// Specifiers of static imports, re-exports, side-effect imports, and dynamic imports with a literal argument.
const SPECIFIERS = [/\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g];

test('skill names are unique across families', () => {
  const seen = new Map();
  for (const skill of skills) {
    assert.ok(!seen.has(skill.name), `${skill.family}/${skill.name} duplicates ${seen.get(skill.name)}: installs are keyed by skill name`);
    seen.set(skill.name, `${skill.family}/${skill.name}`);
  }
});

for (const skill of skills) {
  const label = `${skill.family}/${skill.name}`;
  const text = readFileSync(join(skill.dir, 'SKILL.md'), 'utf8');

  test(`${label}: name and description avoid reserved words and XML tags`, () => {
    assert.doesNotMatch(skill.name, /anthropic|claude/i, 'name must not contain "anthropic" or "claude"');
    for (const key of ['name', 'description']) assert.doesNotMatch(field(text, key), /<\/?[a-z][^>]*>/i, `${key} must not contain XML tags`);
  });

  test(`${label}: SKILL.md is under 500 lines and has a Gotchas section`, () => {
    const lines = text.split('\n').length;
    assert.ok(lines < 500, `SKILL.md has ${lines} lines: move detail into references/`);
    assert.match(text, /^##\s+Gotchas\b/m, 'SKILL.md needs a "## Gotchas" section');
  });

  test(`${label}: references/ is one level deep`, () => {
    const refs = join(skill.dir, 'references');
    if (!existsSync(refs)) return;
    assert.deepEqual(dirs(refs), [], 'references/ must not contain subfolders: link each file directly from SKILL.md');
  });

  test(`${label}: scripts import only node: builtins and files inside the skill folder`, () => {
    const scripts = join(skill.dir, 'scripts');
    if (!existsSync(scripts)) return;
    for (const file of files(scripts).filter((f) => f.endsWith('.mjs'))) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of SPECIFIERS) {
        for (const [, specifier] of source.matchAll(pattern)) {
          if (specifier.startsWith('node:')) continue;
          const where = `${relative(skill.dir, file)} imports "${specifier}"`;
          assert.ok(specifier.startsWith('./'), `${where}: only node: builtins and ./ files are allowed (skills must be self-contained, with no dependencies)`);
          const target = resolve(dirname(file), specifier);
          assert.ok(!relative(skill.dir, target).startsWith('..'), `${where}: points outside the skill folder`);
          assert.ok(existsSync(target), `${where}: file does not exist (run "npm run sync" if it is shared code)`);
        }
      }
    }
  });

  test(`${label}: has evals.json and a row in the README skills table`, () => {
    assert.ok(existsSync(join(root, 'evals', skill.family, 'config.json')), `evals/${skill.family}/config.json is missing`);
    assert.ok(existsSync(join(root, 'evals', skill.family, skill.name, 'evals.json')), `evals/${skill.family}/${skill.name}/evals.json is missing`);
    assert.match(readme, new RegExp(`^\\|\\s*\`${skill.name}\``, 'm'), `README.md Skills table has no row for \`${skill.name}\``);
  });
}

test('every family has a README subsection and an install line', () => {
  for (const family of new Set(skills.map((s) => s.family))) {
    const title = family.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    assert.match(readme, new RegExp(`^###\\s+${title}\\b`, 'm'), `README.md needs a "### ${title}" subsection under Skills`);
    assert.ok(readme.includes(`/plugin install nr-${family}@`), `README.md needs an install line for nr-${family}`);
  }
});

test('skills were found', () => {
  assert.ok(skills.length > 0);
});
