export interface SteelProviderOptions {
  env?: Record<string, string | undefined>;
  apiKey?: string;
  packageRoot?: string;
  cacheRoot?: string;
  extensionZip?: string;
  extensionId?: string;
  extensionBase64?: string;
  seleniumExtensionPath?: string;
  uploadTimeoutMs?: number | string;
  uploadMaxRetries?: number | string;
  timeoutMs?: number | string;
  sessionOptions?: Record<string, unknown>;
  client?: any;
  Steel?: any;
  playwright?: unknown;
  puppeteer?: unknown;
  seleniumWebDriver?: any;
  seleniumHttp?: any;
  ptkExtensions?: any;
  chromium?: unknown;
  browserName?: string;
  capabilities?: Record<string, unknown>;
  seleniumRemoteUrl?: string;
  remoteUrl?: string;
  scriptTimeoutMs?: number | string;
  readinessTimeoutMs?: number | string;
  seleniumReadinessWait?: (milliseconds: number) => Promise<void>;
  connectOptions?: Record<string, unknown>;
  contextOptions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SteelExtension {
  extensionId: string;
  source: 'env' | 'cache' | 'upload' | string;
  artifact?: unknown;
  [key: string]: unknown;
}

export interface SteelPlaywrightConnection {
  client: any;
  extension: SteelExtension;
  session: any;
  sessionInfo: Record<string, unknown>;
  seleniumExtension: Record<string, unknown> | null;
  browser: any;
  context: any;
  page: any;
  framework: "playwright";
  close(): Promise<void>;
}

export interface SteelPuppeteerConnection {
  client: any;
  extension: SteelExtension;
  session: any;
  sessionInfo: Record<string, unknown>;
  browser: any;
  page: any;
  framework: "puppeteer";
  close(): Promise<void>;
}

export interface SteelSeleniumConnection {
  client: any;
  extension: SteelExtension;
  session: any;
  sessionInfo: Record<string, unknown>;
  remoteUrl: unknown;
  driver: any;
  framework: "selenium";
  close(): Promise<void>;
}

export function connectSteelPlaywright(options?: SteelProviderOptions): Promise<SteelPlaywrightConnection>;
export function connectSteelPuppeteer(options?: SteelProviderOptions): Promise<SteelPuppeteerConnection>;
export function connectSteelSelenium(options?: SteelProviderOptions): Promise<SteelSeleniumConnection>;
export function createSteelSeleniumExecutor(session: { id?: string }, options?: SteelProviderOptions): any;
export function createSteelSeleniumDriver(session: { id?: string }, options?: SteelProviderOptions): Promise<any>;
export function inspectSteelExtensionRuntime(connection: SteelSeleniumConnection): Promise<Record<string, unknown>>;
export function createSteelClient(options?: SteelProviderOptions): any;
export function resolveSteelExtensionId(client: any, options?: SteelProviderOptions): Promise<SteelExtension>;
export function releaseSteelSession(client: any, session: { id?: string }, options?: SteelProviderOptions): Promise<void>;
export function steelConnectUrl(session: { websocketUrl?: string; id?: string }, options?: SteelProviderOptions): string;
export function steelSessionOptions(extensionId: string | string[], options?: SteelProviderOptions): Record<string, unknown>;
export function steelResultsDir(framework: string, options?: SteelProviderOptions): string;
export function steelSeleniumCapabilities(options?: SteelProviderOptions): Record<string, unknown>;
export function steelSeleniumRemoteUrl(options?: SteelProviderOptions): string;
declare const api: unknown;
export default api;
