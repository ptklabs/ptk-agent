'use strict';

const { extractPtkFindings, findingFingerprint, normalizeFinding } = require('../evidence/ptkEvidenceAdapter.cjs');

function createFindingFingerprintDiff({ baseline = {}, final = {}, agent = null } = {}) {
  const baselineMap = findingMap(baseline);
  const finalMap = findingMap(final);
  const newUniqueFindings = diffMaps(finalMap, baselineMap);
  const lostUniqueFindings = diffMaps(baselineMap, finalMap);
  const duplicateFindings = duplicateCount(final);
  const baselineSource = findingSourceSummary(baseline);
  const finalSource = findingSourceSummary(final);
  const comparisonReliable = Boolean(baselineSource.complete && finalSource.complete);
  const comparisonReason = comparisonReliable
    ? 'complete_export_comparison'
    : `unreliable_${baselineSource.reason || 'baseline_unknown'}_${finalSource.reason || 'final_unknown'}`;
  return {
    schemaVersion: 'ptk-agent-v2-finding-fingerprint-diff',
    generatedAt: new Date().toISOString(),
    baselineUniqueFindings: baselineMap.size,
    finalUniqueFindings: finalMap.size,
    baselineSource,
    finalSource,
    comparisonReliable,
    comparisonReason,
    newUniqueFindings,
    lostUniqueFindings,
    duplicateFindings,
    severityDelta: severityDelta(baselineMap, finalMap),
    highCriticalDelta: highCriticalCount(finalMap) - highCriticalCount(baselineMap),
    agentAddedUniqueFindings: comparisonReliable ? newUniqueFindings.length : 0,
    agentLostUniqueFindings: comparisonReliable ? lostUniqueFindings.length : 0,
    agentRegression: comparisonReliable ? lostUniqueFindings.length > 0 : false
  };
}

function findingMap(coverage = {}) {
  const out = new Map();
  for (const finding of rawFindingsFromCoverage(coverage)) {
    const fingerprint = findingFingerprint(finding);
    if (!fingerprint || out.has(fingerprint)) continue;
    const normalized = normalizeFinding(finding);
    out.set(fingerprint, {
      fingerprint,
      id: normalized.id,
      engine: normalized.engine,
      title: normalized.title,
      severity: normalized.severity,
      confidence: normalized.confidence,
      url: normalized.url,
      method: normalized.method,
      parameter: normalized.parameter,
      ruleId: normalized.ruleId
    });
  }
  return out;
}

function rawFindingsFromCoverage(coverage = {}) {
  const ptk = coverage && coverage.ptk || {};
  const sources = [
    ptk.evidence,
    ptk.evidence && ptk.evidence.export,
    ptk.export,
    ptk.findings,
    ptk.findings && ptk.findings.findings,
    coverage.agentPtkSignals,
    coverage.agentPtkSignals && coverage.agentPtkSignals.findings,
    coverage.findings
  ].filter(Boolean);
  const out = [];
  for (const source of sources) out.push(...extractPtkFindings(source));
  return out;
}

function findingSourceSummary(coverage = {}) {
  const ptk = coverage && coverage.ptk || {};
  const hasExport = Boolean(
    ptk.evidence && ptk.evidence.export ||
    ptk.export ||
    ptk.exported && ptk.evidence
  );
  if (hasExport) {
    return {
      source: 'export',
      complete: true,
      diagnosticOnly: false,
      count: findingMap(coverage).size,
      reason: 'export'
    };
  }
  const signals = coverage && coverage.agentPtkSignals;
  if (signals && (Array.isArray(signals.findings) || Number(signals.findingsCount) > 0)) {
    return {
      source: 'pre-agent-findings-api',
      complete: false,
      diagnosticOnly: true,
      count: Number(signals.findingsCount) || (Array.isArray(signals.findings) ? signals.findings.length : 0),
      reason: 'diagnostic_findings_api_snapshot'
    };
  }
  if (ptk.findings || coverage.findings) {
    return {
      source: 'findings-api',
      complete: false,
      diagnosticOnly: true,
      count: findingMap(coverage).size,
      reason: 'findings_api_without_export'
    };
  }
  return {
    source: 'none',
    complete: false,
    diagnosticOnly: true,
    count: 0,
    reason: 'no_findings_source'
  };
}

function diffMaps(left, right) {
  const out = [];
  for (const [fingerprint, finding] of left.entries()) {
    if (!right.has(fingerprint)) out.push(finding);
  }
  return out;
}

function duplicateCount(coverage = {}) {
  const raw = rawFindingsFromCoverage(coverage);
  const seen = new Set();
  let duplicates = 0;
  for (const finding of raw) {
    const fingerprint = findingFingerprint(finding);
    if (!fingerprint) continue;
    if (seen.has(fingerprint)) duplicates += 1;
    seen.add(fingerprint);
  }
  return duplicates;
}

function severityDelta(baselineMap, finalMap) {
  const before = severityCounts(baselineMap);
  const after = severityCounts(finalMap);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out = {};
  for (const key of keys) out[key] = (after[key] || 0) - (before[key] || 0);
  return out;
}

function severityCounts(map) {
  const out = {};
  for (const finding of map.values()) {
    const severity = finding.severity || 'unknown';
    out[severity] = (out[severity] || 0) + 1;
  }
  return out;
}

function highCriticalCount(map) {
  let count = 0;
  for (const finding of map.values()) {
    if (finding.severity === 'high' || finding.severity === 'critical') count += 1;
  }
  return count;
}

module.exports = {
  createFindingFingerprintDiff,
  findingMap,
  findingSourceSummary
};
