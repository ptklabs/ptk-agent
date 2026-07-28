export type PtkEngine = "DAST" | "IAST" | "SAST" | "SCA" | string;

export interface PtkPageLike {
  evaluate<T = unknown>(pageFunction: Function | string, arg?: unknown): Promise<T>;
  goto?(url: string, options?: object): Promise<unknown>;
  waitForTimeout?(ms: number): Promise<void>;
}

export interface PtkScanOptions {
  project?: string;
  engines?: PtkEngine[];
  deferStart?: boolean;
  preNavigationArm?: boolean | {
    extensionOrigin?: string;
    timeoutMs?: number;
    ttlMs?: number;
  };
  preNavigationArmTimeoutMs?: number;
  bootstrapUrl?: string;
  bootstrapWaitUntil?: "load" | "domcontentloaded" | "networkidle" | string;
  bootstrapTimeoutMs?: number;
  bootstrapRetries?: number;
  bootstrapRetryDelayMs?: number;
  bootstrap?: {
    url?: string;
    waitUntil?: "load" | "domcontentloaded" | "networkidle" | string;
    timeout?: number;
    timeoutMs?: number;
    retries?: number;
    maxRetries?: number;
    retryDelay?: number;
    retryDelayMs?: number;
  };
  resultsDir?: string;
  artifactMode?: "report" | "debug" | "diagnostic" | "diagnostics" | "full" | "legacy" | string;
  artifacts?: {
    mode?: "report" | "debug" | "diagnostic" | "diagnostics" | "full" | "legacy" | string;
  };
  findingsLimit?: number;
  wait?: {
    timeoutMs?: number;
    pollMs?: number;
    activate?: boolean;
    bootstrapUrl?: string;
  };
  stop?: {
    wait?: boolean;
    immediateAnalysis?: boolean;
  };
  collect?: {
    beforeStop?: boolean | {
      progress?: boolean;
      findings?: boolean;
      stats?: boolean;
    };
    afterStop?: boolean | {
      progress?: boolean;
      findings?: boolean;
      stats?: boolean;
    };
    export?: boolean;
    timeoutMs?: number;
    pollMs?: number;
    limit?: number;
  };
  engineConfigs?: {
    DAST?: {
      allowCaptureWithoutInteraction?: boolean;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  throwOnError?: boolean;
  [key: string]: unknown;
}

export interface PtkStartScanResult {
  session: unknown;
  ptk: PtkBridge;
}

export type StartPtkScan = (options?: {
  wait?: object;
  session?: object;
  scan?: object;
  scanOptions?: object;
  [key: string]: unknown;
}) => Promise<PtkStartScanResult>;

export interface PtkScanLifecycle {
  deferred?: boolean;
  lifecycleStatus?: string | null;
  scanStarted?: boolean;
  scanStartedAt?: string | null;
  scanStartUrl?: string | null;
  sessionStarted?: boolean;
  sessionStopped?: boolean;
}

export interface PtkScanSuccess<T = unknown> {
  ok: true;
  deferred?: boolean;
  lifecycleStatus?: string | null;
  scanStarted?: boolean;
  scanStartedAt?: string | null;
  scanStartUrl?: string | null;
  sessionStarted?: boolean;
  sessionStopped?: boolean;
  session?: unknown;
  beforeStop?: unknown;
  afterStop?: unknown;
  stop?: unknown;
  bootstrap?: unknown;
  preNavigationArm?: unknown;
  resultsDir?: string | null;
  journeyResult?: T;
}

export interface PtkScanFailure {
  ok: false;
  deferred?: boolean;
  lifecycleStatus?: string | null;
  scanStarted?: boolean;
  scanStartedAt?: string | null;
  scanStartUrl?: string | null;
  sessionStarted?: boolean;
  sessionStopped?: boolean;
  session?: unknown;
  beforeStop?: unknown;
  afterStop?: unknown;
  stop?: unknown;
  bootstrap?: unknown;
  preNavigationArm?: unknown;
  error?: unknown;
  stopError?: unknown;
  resultsDir?: string | null;
}

export type PtkScanResult<T = unknown> = PtkScanSuccess<T> | PtkScanFailure;

export interface PtkBridge {
  sessionId?: string | null;
  ping(): Promise<unknown>;
  waitReady(options?: object): Promise<unknown>;
  requestActivation(options?: object): Promise<unknown>;
  startSession(options?: object): Promise<unknown>;
  endSession(options?: object): Promise<unknown>;
  getStats(options?: object): Promise<unknown>;
  getFindings(options?: object | number): Promise<unknown>;
  getSessionProgress(options?: object): Promise<unknown>;
  exportScan(options?: object): Promise<unknown>;
  call(method: string, options?: object): Promise<unknown>;
}

export class PTKBridge implements PtkBridge {
  constructor(page: PtkPageLike, options?: object);
  sessionId?: string | null;
  ping(): Promise<unknown>;
  waitReady(options?: object): Promise<unknown>;
  requestActivation(options?: object): Promise<unknown>;
  startSession(options?: object): Promise<unknown>;
  endSession(options?: object): Promise<unknown>;
  getStats(options?: object): Promise<unknown>;
  getFindings(options?: object | number): Promise<unknown>;
  getSessionProgress(options?: object): Promise<unknown>;
  exportScan(options?: object): Promise<unknown>;
  call(method: string, options?: object): Promise<unknown>;
}

export class PtkBridgeError extends Error {
  code: string;
  details?: unknown;
}

export class PtkScanError extends Error {
  code?: string;
  result?: unknown;
}

export function createPtkBridge(page: PtkPageLike, options?: object): PtkBridge;
export function waitForPtk(page: PtkPageLike, options?: object): Promise<unknown>;
export function bootstrapPtkPage(page: PtkPageLike, options?: PtkScanOptions): Promise<unknown>;
export function armPtkIastForNavigation(page: PtkPageLike, options?: object): Promise<unknown>;
export function collectPtkResults(pageOrBridge: PtkPageLike | PtkBridge, session?: unknown, options?: object): Promise<unknown>;
export function writePtkResults(result: unknown, resultsDir: string, options?: object): string[];
export function resolveArtifactMode(options?: object): "report" | "debug";
export function countFindings(payload: unknown): number;
export function applyAutomationScanDefaults(options?: PtkScanOptions): PtkScanOptions;
export function withPtkScan<T>(
  page: PtkPageLike,
  options: PtkScanOptions & { throwOnError: false },
  runJourney: (ctx: { page: PtkPageLike; ptk: PtkBridge; session: unknown; startPtkScan: StartPtkScan; armPtkIastForNavigation: typeof armPtkIastForNavigation }) => Promise<T>
): Promise<PtkScanResult<T>>;
export function withPtkScan<T>(
  page: PtkPageLike,
  options: PtkScanOptions,
  runJourney: (ctx: { page: PtkPageLike; ptk: PtkBridge; session: unknown; startPtkScan: StartPtkScan; armPtkIastForNavigation: typeof armPtkIastForNavigation }) => Promise<T>
): Promise<PtkScanSuccess<T>>;

declare const api: {
  PTKBridge: typeof PTKBridge;
  PtkBridgeError: typeof PtkBridgeError;
  PtkScanError: typeof PtkScanError;
  createPtkBridge: typeof createPtkBridge;
  waitForPtk: typeof waitForPtk;
  bootstrapPtkPage: typeof bootstrapPtkPage;
  armPtkIastForNavigation: typeof armPtkIastForNavigation;
  withPtkScan: typeof withPtkScan;
  collectPtkResults: typeof collectPtkResults;
  applyAutomationScanDefaults: typeof applyAutomationScanDefaults;
  writePtkResults: typeof writePtkResults;
  resolveArtifactMode: typeof resolveArtifactMode;
  countFindings: typeof countFindings;
};

export default api;
