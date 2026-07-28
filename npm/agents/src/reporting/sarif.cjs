'use strict';

const { extractPtkFindings, normalizeFinding } = require('../evidence/ptkEvidenceAdapter.cjs');

const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const SARIF_VERSION = '2.1.0';
const SEVERITY_RANK = Object.freeze({
  unknown: 0,
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5
});
const SECURITY_SEVERITY = Object.freeze({
  critical: '9.5',
  high: '8.0',
  medium: '5.0',
  low: '2.5',
  info: '0.0',
  unknown: '0.0'
});

function normalizedFindingsFromResult(result = {}) {
  const candidates = [
    result.coverage && result.coverage.ptk && result.coverage.ptk.evidence,
    result.coverage && result.coverage.ptk && result.coverage.ptk.findings,
    result.coverage && result.coverage.ptk,
    result.result && result.result.coverage && result.result.coverage.ptk,
    result
  ];
  const raw = [];
  for (const candidate of candidates) {
    raw.push(...extractPtkFindings(candidate || {}));
  }
  const byKey = new Map();
  for (const finding of raw) {
    const normalized = normalizeFinding(finding);
    const key = normalized.fingerprint || normalized.id;
    if (!byKey.has(key)) byKey.set(key, normalized);
  }
  return Array.from(byKey.values());
}

function normalizeThreshold(value = 'none') {
  const normalized = String(value || 'none').trim().toLowerCase();
  if (normalized === 'none') return 'none';
  if (!Object.prototype.hasOwnProperty.call(SEVERITY_RANK, normalized) || normalized === 'unknown') {
    throw new Error('--fail-on must be one of: critical, high, medium, low, info, none');
  }
  return normalized;
}

function evaluateSeverityThreshold(findings = [], threshold = 'none') {
  const failOn = normalizeThreshold(threshold);
  const bySeverity = {};
  for (const finding of findings) {
    const severity = normalizeSarifSeverity(finding.severity);
    bySeverity[severity] = (bySeverity[severity] || 0) + 1;
  }
  if (failOn === 'none') {
    return {
      ok: true,
      failed: false,
      failOn,
      findingCount: findings.length,
      bySeverity,
      failingFindings: []
    };
  }
  const minimum = SEVERITY_RANK[failOn];
  const failingFindings = findings
    .filter((finding) => SEVERITY_RANK[normalizeSarifSeverity(finding.severity)] >= minimum)
    .map((finding) => ({
      id: finding.id,
      title: finding.title,
      severity: normalizeSarifSeverity(finding.severity),
      engine: finding.engine,
      url: finding.url || null,
      ruleId: finding.ruleId || null
    }));
  return {
    ok: failingFindings.length === 0,
    failed: failingFindings.length > 0,
    failOn,
    findingCount: findings.length,
    bySeverity,
    failingCount: failingFindings.length,
    failingFindings
  };
}

function normalizeSarifSeverity(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SEVERITY_RANK, normalized)) return normalized;
  return 'unknown';
}

function sarifLevel(severity) {
  const normalized = normalizeSarifSeverity(severity);
  if (normalized === 'critical' || normalized === 'high') return 'error';
  if (normalized === 'medium' || normalized === 'low') return 'warning';
  return 'note';
}

function ruleKey(finding = {}) {
  const engine = String(finding.engine || 'PTK').toUpperCase();
  const raw = finding.ruleId || finding.category || finding.title || finding.id || 'finding';
  return `${engine}/${String(raw).trim().replace(/\s+/g, '_').slice(0, 120)}`;
}

function ruleHelpUri(finding = {}) {
  if (finding.cwe) return `https://cwe.mitre.org/data/definitions/${String(finding.cwe).replace(/^CWE-/i, '')}.html`;
  return 'https://github.com/ptklabs/ptk-agent';
}

function buildRule(finding = {}) {
  const severity = normalizeSarifSeverity(finding.severity);
  return {
    id: ruleKey(finding),
    name: finding.title || 'PTK finding',
    shortDescription: {
      text: finding.title || 'PTK finding'
    },
    fullDescription: {
      text: finding.raw && finding.raw.description
        ? String(finding.raw.description).slice(0, 1000)
        : `${finding.engine || 'PTK'} finding reported by OWASP PTK.`
    },
    helpUri: ruleHelpUri(finding),
    properties: {
      tags: ['security', 'owasp-ptk', String(finding.engine || 'ptk').toLowerCase()],
      precision: finding.confidence === 'high' ? 'high' : 'medium',
      problem: {
        severity
      },
      'security-severity': SECURITY_SEVERITY[severity] || SECURITY_SEVERITY.unknown
    }
  };
}

function firstSourceLocation(raw = {}) {
  const source = raw.source && typeof raw.source === 'object' ? raw.source : {};
  const location = raw.location && typeof raw.location === 'object' ? raw.location : {};
  const stack = Array.isArray(raw.stack) ? raw.stack : [];
  const candidate = [
    raw.file,
    raw.filename,
    raw.path,
    source.file,
    source.path,
    location.file,
    location.path,
    stack[0] && (stack[0].file || stack[0].path)
  ].find(Boolean);
  if (!candidate) return null;
  const line = Number(raw.line || source.line || location.line || stack[0] && stack[0].line || 1);
  const column = Number(raw.column || source.column || location.column || stack[0] && stack[0].column || 1);
  return {
    uri: String(candidate),
    startLine: Number.isFinite(line) && line > 0 ? line : 1,
    startColumn: Number.isFinite(column) && column > 0 ? column : 1
  };
}

function physicalLocationForFinding(finding = {}) {
  const source = firstSourceLocation(finding.raw || {});
  if (source) {
    return {
      artifactLocation: {
        uri: source.uri
      },
      region: {
        startLine: source.startLine,
        startColumn: source.startColumn
      }
    };
  }
  return {
    artifactLocation: {
      uri: 'ptk-runtime-findings'
    },
    region: {
      startLine: 1,
      startColumn: 1
    }
  };
}

function messageForFinding(finding = {}) {
  const parts = [finding.title || 'PTK finding'];
  if (finding.severity) parts.push(`severity=${normalizeSarifSeverity(finding.severity)}`);
  if (finding.engine) parts.push(`engine=${finding.engine}`);
  if (finding.method || finding.url) parts.push(`location=${[finding.method, finding.url].filter(Boolean).join(' ')}`);
  if (finding.parameter) parts.push(`parameter=${finding.parameter}`);
  return parts.join(' | ');
}

function buildSarifResult(finding = {}) {
  const severity = normalizeSarifSeverity(finding.severity);
  return {
    ruleId: ruleKey(finding),
    level: sarifLevel(severity),
    message: {
      text: messageForFinding(finding)
    },
    locations: [
      {
        physicalLocation: physicalLocationForFinding(finding)
      }
    ],
    partialFingerprints: {
      ptkFingerprint: finding.fingerprint || finding.id
    },
    properties: {
      engine: finding.engine || null,
      severity,
      confidence: finding.confidence || null,
      url: finding.url || null,
      method: finding.method || null,
      parameter: finding.parameter || null,
      category: finding.category || null,
      cwe: finding.cwe || null,
      runtimeLocation: !firstSourceLocation(finding.raw || {})
    }
  };
}

function buildSarif(result = {}, options = {}) {
  const findings = options.findings || normalizedFindingsFromResult(result);
  const rules = new Map();
  for (const finding of findings) {
    const key = ruleKey(finding);
    if (!rules.has(key)) rules.set(key, buildRule(finding));
  }
  return {
    version: SARIF_VERSION,
    $schema: SARIF_SCHEMA,
    runs: [
      {
        tool: {
          driver: {
            name: 'OWASP PTK',
            informationUri: 'https://github.com/ptklabs/ptk-agent',
            rules: Array.from(rules.values())
          }
        },
        automationDetails: {
          id: options.category || 'owasp-ptk'
        },
        invocations: [
          {
            executionSuccessful: Boolean(result.ok),
            endTimeUtc: result.telemetry && result.telemetry.endTime || new Date().toISOString()
          }
        ],
        results: findings.map(buildSarifResult),
        properties: {
          target: result.config && result.config.target && result.config.target.baseUrl || null,
          findingCount: findings.length
        }
      }
    ]
  };
}

module.exports = {
  SEVERITY_RANK,
  buildSarif,
  evaluateSeverityThreshold,
  normalizedFindingsFromResult,
  normalizeThreshold
};
