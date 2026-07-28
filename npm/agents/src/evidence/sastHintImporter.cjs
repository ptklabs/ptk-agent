'use strict';

const { adaptAnalysisEvidence } = require('./analysisEvidenceAdapter.cjs');

function importSastHints(input = {}, options = {}) {
  return adaptAnalysisEvidence(input, {
    ...options,
    defaultSourceTag: options.defaultSourceTag || 'sast'
  });
}

module.exports = {
  importSastHints
};
