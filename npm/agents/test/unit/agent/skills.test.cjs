'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  hashRuntimeSkill,
  listRuntimeSkills,
  loadRuntimeSkill,
  resolveSkillPath
} = require('../../../src/agent/skills.cjs');

test('runtime skill loader reads and hashes local SKILL.md files', () => {
  const skill = loadRuntimeSkill('ptk-runtime-crawl-manager');

  assert.equal(skill.name, 'ptk-runtime-crawl-manager');
  assert.match(skill.content, /manager proposes missions/);
  assert.equal(skill.hash, hashRuntimeSkill('ptk-runtime-crawl-manager'));
  assert.equal(skill.hash.length, 64);
});

test('runtime skill listing returns deterministic metadata', () => {
  const skills = listRuntimeSkills({ includeContent: false });
  const names = skills.map((skill) => skill.name);

  assert.ok(names.includes('ptk-runtime-crawl-manager'));
  assert.equal(skills.find((skill) => skill.name === 'ptk-runtime-crawl-manager').content, undefined);
});

test('runtime skill paths reject traversal names', () => {
  assert.throws(() => resolveSkillPath('../outside-package'), /Invalid runtime skill name/);
});
