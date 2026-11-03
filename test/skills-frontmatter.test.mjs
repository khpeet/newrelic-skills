// Checks every skills/<family>/<skill>/SKILL.md against the Agent Skills specification
// (https://agentskills.io/specification) and the plugin manifest, offline and without dependencies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from '../shared/workflow-automation/js-yaml.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dirs = (dir) => readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const skills = dirs(join(root, 'skills')).flatMap((family) =>
  dirs(join(root, 'skills', family)).map((name) => ({ family, name, dir: join(root, 'skills', family, name) })),
);

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;
// Inline markdown links, ignoring images and fenced code blocks.
const LINK = /(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g;
const slug = (heading) => heading.trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-');

function parse(skill) {
  const text = readFileSync(join(skill.dir, 'SKILL.md'), 'utf8');
  const match = text.match(FRONTMATTER);
  assert.ok(match, `${skill.name}: SKILL.md must start with YAML frontmatter`);
  return { meta: load(match[1]), body: text.slice(match[0].length) };
}

test('skills exist', () => {
  assert.ok(skills.length > 0);
  for (const skill of skills) assert.ok(existsSync(join(skill.dir, 'SKILL.md')), `${skill.family}/${skill.name} has no SKILL.md`);
});

for (const skill of skills) {
  test(`${skill.family}/${skill.name}: frontmatter follows the spec`, () => {
    const { meta } = parse(skill);
    assert.equal(typeof meta.name, 'string');
    assert.match(meta.name, NAME, 'name: lowercase letters, digits, and single hyphens, not at either end');
    assert.ok(meta.name.length <= 64, 'name: at most 64 characters');
    assert.equal(meta.name, skill.name, 'name must match the folder name');

    assert.equal(typeof meta.description, 'string');
    assert.ok(meta.description.trim().length >= 1 && meta.description.length <= 1024, `description: 1-1024 characters (got ${meta.description.length})`);

    if (meta.compatibility !== undefined) {
      assert.equal(typeof meta.compatibility, 'string');
      assert.ok(meta.compatibility.length <= 500, `compatibility: at most 500 characters (got ${meta.compatibility.length})`);
    }
    if (meta.metadata !== undefined) {
      assert.ok(meta.metadata && typeof meta.metadata === 'object' && !Array.isArray(meta.metadata), 'metadata must be a mapping');
      for (const [key, value] of Object.entries(meta.metadata)) assert.equal(typeof value, 'string', `metadata.${key} must be a string`);
    }
  });

  test(`${skill.family}/${skill.name}: relative links resolve inside the skill folder`, () => {
    const { body } = parse(skill);
    const prose = body.replace(/```[\s\S]*?```/g, '');
    const anchors = new Set([...prose.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));
    for (const [, target] of prose.matchAll(LINK)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [path, fragment] = target.split('#');
      if (!path) {
        assert.ok(anchors.has(fragment), `${target}: no heading with that anchor`);
        continue;
      }
      const full = resolve(skill.dir, decodeURIComponent(path));
      const rel = relative(skill.dir, full);
      assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`), `${target} points outside the skill folder`);
      assert.ok(existsSync(full), `${target} does not exist`);
    }
  });
}

test('marketplace.json: one plugin per family, each skill listed exactly once, every listed skill exists', () => {
  const marketplace = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.ok(!existsSync(join(root, '.claude-plugin', 'plugin.json')), 'a root plugin.json would apply to every plugin entry; list skills in marketplace.json instead');
  const listed = [];
  for (const plugin of marketplace.plugins) {
    assert.equal(plugin.source, './', `${plugin.name}: source must be "./" so skills stay at skills/<family>/<skill>/`);
    assert.ok(Array.isArray(plugin.skills) && plugin.skills.length > 0, `${plugin.name}: skills must be a non-empty array`);
    const families = new Set();
    for (const path of plugin.skills) {
      assert.ok(path.startsWith('./'), `${plugin.name}: ${path} must start with ./`);
      const dir = resolve(root, path);
      assert.ok(existsSync(join(dir, 'SKILL.md')), `${plugin.name}: ${path} has no SKILL.md`);
      families.add(relative(join(root, 'skills'), dir).split(sep)[0]);
      listed.push(dir);
    }
    assert.equal(families.size, 1, `${plugin.name}: skills must all belong to one family (got ${[...families].join(', ')})`);
  }
  for (const skill of skills) {
    const count = listed.filter((dir) => dir === skill.dir).length;
    assert.equal(count, 1, `${skill.family}/${skill.name} must be listed in exactly one marketplace.json plugin (found ${count})`);
  }
});
