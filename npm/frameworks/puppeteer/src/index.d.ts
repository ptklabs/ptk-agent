export * from "../../../browser/src";

export interface LaunchPtkBrowserOptions {
  puppeteer?: unknown;
  puppeteerPackage?: string;
  extensionPath?: string;
  profileDir?: string;
  executablePath?: string;
  headless?: boolean;
  allowHeadlessExtension?: boolean;
  launchOptions?: object;
  args?: string[];
  page?: unknown;
  [key: string]: unknown;
}

export class PTKPuppeteerBridge {
  constructor(page: import("../../../browser/src").PtkPageLike);
  sessionId?: string | null;
  ping(): Promise<unknown>;
  waitReady(timeoutMs?: number, options?: object): Promise<unknown>;
  requestActivation(options?: object): Promise<unknown>;
  startSession(options?: object): Promise<unknown>;
  endSession(options?: object): Promise<unknown>;
  getStats(): Promise<unknown>;
  getFindings(options?: object | number): Promise<unknown>;
  getSessionProgress(options?: object): Promise<unknown>;
  exportScan(options?: object): Promise<unknown>;
}

export function launchPtkBrowser(options?: LaunchPtkBrowserOptions): Promise<{
  browser: unknown;
  page: import("../../../browser/src").PtkPageLike;
  ptk: PTKPuppeteerBridge;
  extensionPath: string;
  profileDir: string;
  launchOptions: object;
}>;
export function resolvePuppeteer(options?: object): unknown;
export function resolveExtensionPath(options?: object): string | null;
export function buildLaunchArgs(extensionPath: string, extraArgs?: string[]): string[];

declare const api: {
  PTKPuppeteerBridge: typeof PTKPuppeteerBridge;
  launchPtkBrowser: typeof launchPtkBrowser;
  resolvePuppeteer: typeof resolvePuppeteer;
  resolveExtensionPath: typeof resolveExtensionPath;
  buildLaunchArgs: typeof buildLaunchArgs;
  createPtkBridge: typeof import("../../../browser/src").createPtkBridge;
  waitForPtk: typeof import("../../../browser/src").waitForPtk;
  bootstrapPtkPage: typeof import("../../../browser/src").bootstrapPtkPage;
  withPtkScan: typeof import("../../../browser/src").withPtkScan;
  collectPtkResults: typeof import("../../../browser/src").collectPtkResults;
  writePtkResults: typeof import("../../../browser/src").writePtkResults;
  countFindings: typeof import("../../../browser/src").countFindings;
};

export default api;
