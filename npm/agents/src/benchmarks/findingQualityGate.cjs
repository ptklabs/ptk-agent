'use strict';

const { extractPtkFindings, normalizeFinding } = require('../evidence/ptkEvidenceAdapter.cjs');

const JUICE_SHOP_REQUIRED_FINDINGS = Object.freeze([
  {
    id: 'jwt-none-cookie',
    label: 'JWT None Algorithm via cookie',
    target: 'juice-shop',
    match: ({ normalized, text }) => isDast(normalized) && /jwt none algorithm/i.test(text) && /\bcookie\b/i.test(text)
  },
  {
    id: 'jwt-none-header',
    label: 'JWT None Algorithm via Authorization header',
    target: 'juice-shop',
    match: ({ normalized, text }) => isDast(normalized) && /jwt none algorithm/i.test(text) && /authorization|header/i.test(text)
  },
  {
    id: 'sql-injection-login',
    label: 'SQL Injection on login',
    target: 'juice-shop',
    match: ({ normalized, text }) => isDast(normalized) && /sql injection/i.test(text) && /\/rest\/user\/login|\blogin\b/i.test(text)
  },
  {
    id: 'xss-feedback-or-challenges',
    label: 'XSS on customer feedback or Challenges API',
    target: 'juice-shop',
    match: ({ normalized, text }) => isDast(normalized)
      && /xss|cross-site scripting/i.test(text)
      && /\/api\/Challenges|\/api\/Feedbacks|feedback|customer feedback|complain/i.test(text)
  },
  {
    id: 'spa-dom-xss-search',
    label: 'SPA DOM XSS on search',
    target: 'juice-shop',
    match: ({ raw, normalized, text }) => isConfirmedDomXssFinding(raw, normalized, text)
      && /#\/search|\/search\b|queryParams\.q|snapshot\.queryParams\.q/i.test(text)
  }
]);

function evaluateFindingQualityGate({ targetId, coverage = {}, requiredFindings = null } = {}) {
  const requirements = (requiredFindings || requirementsForTarget(targetId)).slice();
  const applicable = requirements.length > 0;
  const findings = rawFindingsFromCoverage(coverage).map(raw => {
    const normalized = normalizeFinding(raw);
    return {
      raw,
      normalized,
      text: findingSearchText(raw, normalized)
    };
  });
  const required = requirements.map(requirement => {
    const match = findings.find(finding => requirement.match(finding));
    return {
      id: requirement.id,
      label: requirement.label,
      satisfied: Boolean(match),
      match: match ? summarizeFinding(match.normalized) : null
    };
  });
  const missing = required.filter(item => !item.satisfied).map(item => item.id);
  return {
    schemaVersion: 'ptk-agent-v2-finding-quality-gate',
    generatedAt: new Date().toISOString(),
    target: targetId || null,
    applicable,
    status: applicable ? missing.length === 0 ? 'passed' : 'failed' : 'not_applicable',
    passed: applicable ? missing.length === 0 : null,
    totalFindingsEvaluated: findings.length,
    required,
    missing
  };
}

function requirementsForTarget(targetId) {
  if (String(targetId || '').toLowerCase() === 'juice-shop') return JUICE_SHOP_REQUIRED_FINDINGS;
  return [];
}

function rawFindingsFromCoverage(coverage = {}) {
  const ptk = coverage && coverage.ptk || {};
  const sources = [
    ptk.evidence,
    ptk.evidence && ptk.evidence.export,
    ptk.export,
    ptk.findings,
    ptk.findings && ptk.findings.findings,
    coverage.findings
  ].filter(Boolean);
  const out = [];
  for (const source of sources) out.push(...extractPtkFindings(source));
  return out;
}

function findingSearchText(raw = {}, normalized = {}) {
  const location = raw.location || {};
  const evidence = raw.evidence || {};
  const dast = evidence.dast || {};
  const sast = evidence.sast || {};
  return [
    normalized.engine,
    normalized.title,
    normalized.ruleId,
    normalized.category,
    normalized.url,
    normalized.method,
    normalized.parameter,
    raw.moduleId,
    raw.moduleName,
    raw.ruleId,
    raw.ruleName,
    raw.vulnId,
    raw.category,
    location.url,
    location.runtimeUrl,
    Array.isArray(location.runtimeUrls) ? location.runtimeUrls.join(' ') : '',
    Array.isArray(location.pageUrls) ? location.pageUrls.join(' ') : '',
    location.pageUrl,
    location.route,
    location.param,
    dast.param,
    dast.proof,
    dast.meta && dast.meta.attacked && dast.meta.attacked.location,
    dast.meta && dast.meta.attacked && dast.meta.attacked.name,
    sast.source && (sast.source.label || sast.source.path || sast.source.sourceName),
    sast.sink && (sast.sink.label || sast.sink.path || sast.sink.sinkName),
    sast.codeSnippet
  ].filter(Boolean).join(' ');
}

function summarizeFinding(finding = {}) {
  return {
    id: finding.id || null,
    engine: finding.engine || null,
    title: finding.title || null,
    ruleId: finding.ruleId || null,
    severity: finding.severity || null,
    confidence: finding.confidence || null,
    url: finding.url || null,
    method: finding.method || null,
    parameter: finding.parameter || null
  };
}

function isDast(finding = {}) {
  return String(finding.engine || '').toUpperCase() === 'DAST';
}

function isConfirmedDomXssFinding(raw = {}, finding = {}, text = '') {
  const findingKind = String(raw.findingKind || raw.evidence && raw.evidence.sast && raw.evidence.sast.findingKind || '').toLowerCase();
  const title = String(finding.title || '');
  const rule = String(finding.ruleId || raw.ruleId || raw.ruleName || '');
  if (findingKind === 'hint') return false;
  return /dom.?xss|dom_xss/i.test(text)
    && (/dom xss/i.test(title) || /dom.?xss.?taint|taint/i.test(rule) || /innerhtml/i.test(text));
}

module.exports = {
  JUICE_SHOP_REQUIRED_FINDINGS,
  evaluateFindingQualityGate,
  requirementsForTarget
};
