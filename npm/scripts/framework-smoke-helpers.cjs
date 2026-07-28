#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_ENGINES = ['DAST', 'IAST', 'SAST', 'SCA'];

function env(name, fallback = null) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function toOptionalBoolean(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return toBoolean(value, undefined);
}

function isoNow() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeName(name) {
  return String(name || 'artifact.json').replace(/[^A-Za-z0-9_.-]/g, '_');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function artifactDir() {
  return ensureDir(path.resolve(env('PTK_ARTIFACTS_DIR', path.join(process.cwd(), '.ptk', 'artifacts'))));
}

function writeJsonArtifact(name, payload) {
  const filePath = path.join(artifactDir(), safeName(name));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Artifact written: ${filePath}`);
  return filePath;
}

function frameworkPayload(config, status, failureReason = null) {
  return {
    framework: config.framework,
    browser: config.browser,
    mode: env('PTK_RELEASE_TEST_MODE', 'source'),
    packageRoot: env('PTK_PACKAGE_ROOT'),
    sdkRoot: config.sdkRoot || null,
    extensionPath: config.extensionPath || null,
    targetUrl: config.baseUrl,
    profileDir: config.profileDir || null,
    artifactsDir: artifactDir(),
    startedAt: config.startedAt,
    endedAt: status === 'started' ? null : isoNow(),
    status,
    failureReason
  };
}

function normalizeEngines(value, fallback = DEFAULT_ENGINES) {
  const valid = new Set(DEFAULT_ENGINES);
  const input = Array.isArray(value) ? value : String(value || '').split(',');
  const out = [];
  const seen = new Set();
  for (const item of input) {
    const engine = String(item || '').trim().toUpperCase();
    if (!valid.has(engine) || seen.has(engine)) continue;
    seen.add(engine);
    out.push(engine);
  }
  return out.length ? out : fallback.slice();
}

function progressEngines(progress) {
  return progress && progress.engines && typeof progress.engines === 'object' ? progress.engines : {};
}

function evaluateEngineGate(progress, requiredEngines) {
  const engines = progressEngines(progress);
  const observed = Object.keys(engines).map((name) => name.toUpperCase()).sort();
  const required = Array.from(new Set(requiredEngines.map((name) => String(name).toUpperCase()))).sort();
  const missing = required.filter((name) => !observed.includes(name));
  const errorEngines = Object.entries(engines)
    .filter(([, payload]) => payload && payload.status === 'error')
    .map(([name]) => name.toUpperCase())
    .sort();
  return {
    requiredEngines: required,
    observedEngines: observed,
    missingEngines: missing,
    errorEngines,
    passed: missing.length === 0 && errorEngines.length === 0
  };
}

function findingsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload && payload.findings)) return payload.findings;
  if (Array.isArray(payload && payload.items)) return payload.items;
  if (Array.isArray(payload && payload.data)) return payload.data;
  if (Array.isArray(payload && payload.data && payload.data.findings)) return payload.data.findings;
  return [];
}

function findingText(value) {
  const parts = [];
  function visit(item) {
    if (item == null) return;
    if (['string', 'number', 'boolean'].includes(typeof item)) {
      parts.push(String(item));
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (typeof item === 'object') {
      Object.keys(item).forEach((key) => {
        parts.push(key);
        visit(item[key]);
      });
    }
  }
  visit(value);
  return parts.join(' ');
}

function findingLabel(finding) {
  if (!finding || typeof finding !== 'object') return String(finding).slice(0, 160);
  const keys = [
    'name',
    'title',
    'moduleName',
    'module_name',
    'attackName',
    'attack_name',
    'vulnerability',
    'ruleName',
    'rule_name',
    'type',
    'id'
  ];
  for (const key of keys) {
    const value = finding[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 220);
  }
  return findingText(finding).slice(0, 220);
}

function requiredFindingSpecsForEngines(engines = DEFAULT_ENGINES) {
  const selected = new Set(normalizeEngines(engines).map((engine) => String(engine || '').toUpperCase()));
  const specs = [
    ['DAST', 'dast_sql_login', 'DAST SQL injection on login', 1],
    ['DAST', 'dast_jwt_none_cookie', 'DAST JWT None Cookie', 1],
    ['DAST', 'dast_jwt_none_authorization', 'DAST JWT None Authorization Header', 1],
    ['DAST', 'dast_spa_dom_xss', 'DAST SPA DOM XSS', 1],
    ['IAST', 'iast_innerhtml', 'IAST DOM XSS via Element.innerHTML', 1],
    ['SAST', 'sast_angular_innerhtml', 'SAST DOM XSS via innerHTML (Angular)', 2]
  ];
  return specs.filter(([engine]) => selected.has(engine));
}

function evaluateRequiredFindings(findings = [], engines = DEFAULT_ENGINES) {
  const matched = {
    dast_sql_login: [],
    dast_jwt_none_cookie: [],
    dast_jwt_none_authorization: [],
    dast_spa_dom_xss: [],
    iast_innerhtml: [],
    sast_angular_innerhtml: []
  };

  for (const finding of findings || []) {
    const text = findingText(finding);
    const lower = text.toLowerCase();
    const label = findingLabel(finding);

    if ((lower.includes('sql') || lower.includes('sqli')) && (
      lower.includes('login') ||
      lower.includes('/rest/user/login') ||
      lower.includes('rest/user/login')
    )) {
      matched.dast_sql_login.push(label);
    }

    if (lower.includes('jwt') && lower.includes('none') && lower.includes('cookie')) {
      matched.dast_jwt_none_cookie.push(label);
    }

    if (lower.includes('jwt') && lower.includes('none') && (
      lower.includes('authorization') ||
      lower.includes('authz') ||
      lower.includes('bearer')
    )) {
      matched.dast_jwt_none_authorization.push(label);
    }

    if (
      (lower.includes('spa') && lower.includes('dom') && lower.includes('xss')) ||
      (lower.includes('spa hash') && lower.includes('xss'))
    ) {
      matched.dast_spa_dom_xss.push(label);
    }

    if (
      lower.includes('dom xss via element.innerhtml') ||
      (lower.includes('element.innerhtml') && lower.includes('dom xss')) ||
      (lower.includes('dom.innerhtml') && lower.includes('iast'))
    ) {
      matched.iast_innerhtml.push(label);
    }

    if (
      lower.includes('dom xss via innerhtml (angular)') ||
      (lower.includes('angular') && lower.includes('innerhtml') && lower.includes('sast')) ||
      lower.includes('dom:angular_property_innerhtml') ||
      lower.includes('dom:angular_renderer_setproperty')
    ) {
      matched.sast_angular_innerhtml.push(label);
    }
  }

  const specs = requiredFindingSpecsForEngines(engines);
  const requirements = specs.map(([, key, description, minimum]) => {
    const samples = matched[key] || [];
    return {
      key,
      description,
      minimum,
      count: samples.length,
      ok: samples.length >= minimum,
      samples: samples.slice(0, 8)
    };
  });

  return {
    ok: requirements.every((item) => item.ok),
    totalFindings: (findings || []).length,
    requiredEngines: normalizeEngines(engines),
    requirements
  };
}

function missingRequirementDescriptions(gate) {
  return (gate.requirements || [])
    .filter((item) => !item.ok)
    .map((item) => item.description);
}

function logFindingGate(gate) {
  console.log('Required finding gate:');
  for (const item of gate.requirements || []) {
    const status = item.ok ? 'OK' : 'MISSING';
    console.log(`  [${status}] ${item.description}: ${item.count}/${item.minimum}`);
    for (const sample of (item.samples || []).slice(0, 3)) {
      console.log(`    - ${sample}`);
    }
  }
}

async function waitForRequiredFindingGate(ptk, config) {
  const startedAt = config.scanStartedAt || Date.now();
  const floorDeadline = startedAt + Math.max(15, config.minScanSeconds || 30) * 1000;
  const hardDeadline = startedAt + Math.max(60, config.requiredFindingsTimeoutSeconds || 300) * 1000;
  let latestPayload = null;
  let latestFindings = [];
  let latestGate = evaluateRequiredFindings([], config.engines);

  while (Date.now() < hardDeadline) {
    const now = Date.now();
    if (now < floorDeadline) {
      await sleep(Math.min(5000, floorDeadline - now));
    }
    latestPayload = await ptk.getFindings({ limit: config.findingsLimit || 500 });
    latestFindings = findingsFromPayload(latestPayload);
    latestGate = evaluateRequiredFindings(latestFindings, config.engines);
    if (latestGate.ok) break;
    await sleep(5000);
  }

  return {
    payload: latestPayload || { findings: latestFindings },
    findings: latestFindings,
    gate: latestGate
  };
}

async function waitForProgressEvidence(ptk, requiredEngines, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await ptk.getSessionProgress();
    const gate = evaluateEngineGate(last, requiredEngines);
    if (gate.missingEngines.length === 0) return last;
    await sleep(2000);
  }
  return last || {};
}

function requireSmokeCredentials(config) {
  if (
    !config.loginEmail ||
    !config.loginPassword ||
    config.loginEmail === 'YOUR_USERNAME' ||
    config.loginPassword === 'YOUR_PASSWORD'
  ) {
    throw new Error('PTK_LOGIN_EMAIL/PTK_LOGIN_PASSWORD are required for the Juice Shop smoke test');
  }
}

module.exports = {
  DEFAULT_ENGINES,
  artifactDir,
  env,
  evaluateEngineGate,
  evaluateRequiredFindings,
  findingsFromPayload,
  frameworkPayload,
  isoNow,
  logFindingGate,
  missingRequirementDescriptions,
  normalizeEngines,
  requireSmokeCredentials,
  sleep,
  toBoolean,
  toOptionalBoolean,
  waitForProgressEvidence,
  waitForRequiredFindingGate,
  writeJsonArtifact
};
