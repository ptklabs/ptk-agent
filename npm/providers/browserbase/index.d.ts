export interface BrowserbaseProviderOptions {
  env?: Record<string, string | undefined>;
  apiKey?: string;
  apiBase?: string;
  packageRoot?: string;
  cacheRoot?: string;
  extensionZip?: string;
  extensionId?: string;
  projectId?: string;
  region?: string;
  timeoutSeconds?: number | string;
  scriptTimeoutMs?: number | string;
  framework?: string;
  purpose?: string;
  userMetadata?: Record<string, unknown>;
  playwright?: unknown;
  puppeteer?: unknown;
  seleniumWebDriver?: unknown;
  chromium?: unknown;
  connectOptions?: Record<string, unknown>;
  contextOptions?: Record<string, unknown>;
  browserName?: string;
  capabilities?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BrowserbaseExtension {
  extensionId: string;
  source: 'env' | 'cache' | 'upload' | string;
  artifact?: unknown;
  [key: string]: unknown;
}

export interface BrowserbasePlaywrightConnection {
  extension: BrowserbaseExtension;
  session: any;
  sessionInfo: Record<string, unknown>;
  browser: any;
  context: any;
  page: any;
  framework: "playwright";
  close(): Promise<void>;
}

export interface BrowserbasePuppeteerConnection {
  extension: BrowserbaseExtension;
  session: any;
  sessionInfo: Record<string, unknown>;
  browser: any;
  page: any;
  framework: "puppeteer";
  close(): Promise<void>;
}

export interface BrowserbaseSeleniumConnection {
  extension: BrowserbaseExtension;
  session: any;
  sessionInfo: Record<string, unknown>;
  driver: any;
  framework: "selenium";
  close(): Promise<void>;
}

export const VALID_REGIONS: Set<string>;
export function browserbaseFetch(pathname: string, requestOptions?: object, providerOptions?: BrowserbaseProviderOptions): Promise<unknown>;
export function resolveBrowserbaseExtensionId(options?: BrowserbaseProviderOptions): Promise<BrowserbaseExtension>;
export function createBrowserbaseSession(extensionId: string, options?: BrowserbaseProviderOptions): Promise<any>;
export function createBrowserbaseSession(options: BrowserbaseProviderOptions & { extensionId: string }): Promise<any>;
export function releaseBrowserbaseSession(sessionId: string, options?: BrowserbaseProviderOptions): Promise<unknown>;
export function browserbaseHttpAgent(session: { signingKey: string }): unknown;
export function browserbaseResultsDir(framework: string, options?: BrowserbaseProviderOptions): string;
export function browserbaseValidationSummary(framework: string, options?: BrowserbaseProviderOptions): unknown;
export function connectBrowserbasePlaywright(options?: BrowserbaseProviderOptions): Promise<BrowserbasePlaywrightConnection>;
export function connectBrowserbasePuppeteer(options?: BrowserbaseProviderOptions): Promise<BrowserbasePuppeteerConnection>;
export function connectBrowserbaseSelenium(options?: BrowserbaseProviderOptions): Promise<BrowserbaseSeleniumConnection>;
export function validateOnlyEnabled(options?: BrowserbaseProviderOptions): boolean;
declare const api: unknown;
export default api;
