export interface PtkExtensionArtifact {
  browser: 'chromium' | 'firefox';
  format: 'zip' | 'crx' | 'xpi' | 'unpacked';
  type: 'zip' | 'crx' | 'xpi' | 'directory';
  path: string;
  version: string | null;
  packageVersion: string | null;
  sha256: string;
  size: number;
  manifestVersion: number | null;
  automationEnabled: boolean;
  automationEnabledDefault: boolean;
  provenance: unknown;
  source?: string;
  keyPath?: string;
}

export interface PtkExtensionOptions {
  packageRoot?: string;
  cacheRoot?: string;
  extensionPath?: string;
  crxPath?: string;
  firefoxZipPath?: string;
  xpiPath?: string;
  keyPath?: string;
  chromeBinary?: string;
}

export function automationCacheRoot(options?: PtkExtensionOptions): string;
export function ensurePtkCrx(options?: PtkExtensionOptions): PtkExtensionArtifact;
export function ensurePtkXpi(options?: PtkExtensionOptions): PtkExtensionArtifact;
export function ensureUnpackedPtkExtension(options?: PtkExtensionOptions): PtkExtensionArtifact;
export function getPtkExtensionMetadata(options?: PtkExtensionOptions): unknown;
export function resolvePtkExtensionArtifact(options?: PtkExtensionOptions): PtkExtensionArtifact;
export function resolvePtkCrxArtifact(options?: PtkExtensionOptions): PtkExtensionArtifact;
export function resolvePtkFirefoxZipArtifact(options?: PtkExtensionOptions): PtkExtensionArtifact;
export function resolvePtkXpiArtifact(options?: PtkExtensionOptions): PtkExtensionArtifact;
export function resolvePtkCrxKeyPath(options?: PtkExtensionOptions): string;
export function sha256File(filePath: string): string;
export function validateAutomationExtensionDir(extensionDir: string): { manifest: unknown; devLocal: unknown };
export function validateAutomationZipArtifact(filePath: string, options?: PtkExtensionOptions): PtkExtensionArtifact;
declare const api: {
  automationCacheRoot: typeof automationCacheRoot;
  ensurePtkCrx: typeof ensurePtkCrx;
  ensurePtkXpi: typeof ensurePtkXpi;
  ensureUnpackedPtkExtension: typeof ensureUnpackedPtkExtension;
  getPtkExtensionMetadata: typeof getPtkExtensionMetadata;
  resolvePtkExtensionArtifact: typeof resolvePtkExtensionArtifact;
  resolvePtkCrxArtifact: typeof resolvePtkCrxArtifact;
  resolvePtkFirefoxZipArtifact: typeof resolvePtkFirefoxZipArtifact;
  resolvePtkXpiArtifact: typeof resolvePtkXpiArtifact;
  resolvePtkCrxKeyPath: typeof resolvePtkCrxKeyPath;
  sha256File: typeof sha256File;
  validateAutomationExtensionDir: typeof validateAutomationExtensionDir;
  validateAutomationZipArtifact: typeof validateAutomationZipArtifact;
};
export default api;
