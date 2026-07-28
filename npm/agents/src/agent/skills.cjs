'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKILLS_ROOT = path.resolve(__dirname, '../../runtime-skills');

function resolveSkillPath(name = 'ptk-runtime-crawl-manager') {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid runtime skill name: ${name}`);
  }
  const filePath = path.join(SKILLS_ROOT, name, 'SKILL.md');
  if (!filePath.startsWith(SKILLS_ROOT)) {
    throw new Error(`Invalid runtime skill name: ${name}`);
  }
  return filePath;
}

function skillPath(rootDir = path.resolve(__dirname, '../../')) {
  return path.join(rootDir, 'runtime-skills', 'ptk-runtime-crawl-manager', 'SKILL.md');
}

function loadRuntimeSkill(input = 'ptk-runtime-crawl-manager') {
  const name = typeof input === 'string' ? input : (input.name || 'ptk-runtime-crawl-manager');
  const filePath = input.rootDir ? skillPath(input.rootDir) : resolveSkillPath(name);
  const content = fs.readFileSync(filePath, 'utf8');
  return {
    name,
    version: extractVersion(content) || '0.0.0',
    path: filePath,
    hash: crypto.createHash('sha256').update(content).digest('hex'),
    content
  };
}

function extractVersion(content) {
  const match = content.match(/^Version:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

function hashRuntimeSkill(name) {
  return loadRuntimeSkill(name).hash;
}

function listRuntimeSkills({ includeContent = true } = {}) {
  return fs.readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const skill = loadRuntimeSkill(entry.name);
      if (!includeContent) delete skill.content;
      return skill;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = {
  hashRuntimeSkill,
  listRuntimeSkills,
  loadRuntimeSkill,
  resolveSkillPath,
  skillPath,
  extractVersion
};
