import cjs from './index.cjs';

export const PTKBridge = cjs.PTKBridge;
export const PtkBridgeError = cjs.PtkBridgeError;
export const PtkScanError = cjs.PtkScanError;
export const createPtkBridge = cjs.createPtkBridge;
export const waitForPtk = cjs.waitForPtk;
export const bootstrapPtkPage = cjs.bootstrapPtkPage;
export const withPtkScan = cjs.withPtkScan;
export const collectPtkResults = cjs.collectPtkResults;
export const applyAutomationScanDefaults = cjs.applyAutomationScanDefaults;
export const writePtkResults = cjs.writePtkResults;
export const resolveArtifactMode = cjs.resolveArtifactMode;
export const countFindings = cjs.countFindings;
export default cjs;
