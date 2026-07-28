export interface BrowserStackExtensionOptions {
  value?: string | string[];
  values?: string | string[];
  url?: string | string[];
  urls?: string | string[];
  cloudUrl?: string | string[];
  mediaUrl?: string | string[];
  mediaUrls?: string | string[];
  id?: string | string[];
  ids?: string | string[];
  capabilityPath?: string;
  upload?: boolean | string;
  [key: string]: unknown;
}

export interface BrowserStackProviderOptions {
  env?: Record<string, string | undefined>;
  username?: string;
  accessKey?: string;
  packageRoot?: string;
  cacheRoot?: string;
  keyPath?: string;
  remoteUrl?: string;
  wsEndpoint?: string;
  browserName?: string;
  browserVersion?: string;
  os?: string;
  osVersion?: string;
  project?: string;
  build?: string;
  name?: string;
  local?: boolean | string;
  seleniumVersion?: string;
  capabilities?: Record<string, unknown>;
  extension?: BrowserStackExtensionOptions;
  extensionValue?: string | string[];
  extensionValues?: string | string[];
  extensionUrl?: string | string[];
  extensionUrls?: string | string[];
  extensionId?: string | string[];
  extensionIds?: string | string[];
  extensionCapabilityPath?: string;
  upload?: boolean | string;
  uploadUrl?: string;
  requireExtension?: boolean | string;
  playwright?: unknown;
  puppeteer?: unknown;
  seleniumWebDriver?: unknown;
  chromium?: unknown;
  connectOptions?: Record<string, unknown>;
  contextOptions?: Record<string, unknown>;
  connectTimeoutMs?: number;
  connectMode?: "cdp" | "playwright" | string;
  [key: string]: unknown;
}

export interface BrowserStackCredentials {
  username: string;
  accessKey: string;
}

export interface BrowserStackExtensionRegistration {
  source: string;
  capabilityPath?: string;
  values?: string[];
  mediaUrl?: string;
  artifact?: unknown;
}

export interface BrowserStackCdpEndpoint {
  wsEndpoint: string;
  capabilities: Record<string, unknown> | null;
  extension: BrowserStackExtensionRegistration;
}

export interface BrowserStackBrowserConnection<TBrowser = unknown, TPage = unknown> {
  browser: TBrowser;
  page: TPage;
  capabilities: Record<string, unknown> | null;
  extension: BrowserStackExtensionRegistration;
  framework: string;
  close(): Promise<void>;
}

export interface BrowserStackPlaywrightConnection extends BrowserStackBrowserConnection {
  context: unknown;
  connectMode?: string;
}

export interface BrowserStackSeleniumConnection {
  driver: any;
  remoteUrl: string;
  capabilities: Record<string, unknown>;
  framework: "selenium";
  close(): Promise<void>;
}

export function applyBrowserStackExtensionCapability(capabilities: Record<string, unknown>, options?: BrowserStackProviderOptions): BrowserStackExtensionRegistration;
export function browserStackCdpCapabilities(framework: "playwright" | "puppeteer" | string, options?: BrowserStackProviderOptions): {
  capabilities: Record<string, unknown>;
  extension: BrowserStackExtensionRegistration;
};
export function browserStackSeleniumRemoteUrl(options?: BrowserStackProviderOptions): string;
export function browserStackWsEndpoint(framework: "playwright" | "puppeteer" | string, options?: BrowserStackProviderOptions): BrowserStackCdpEndpoint;
export function connectBrowserStackPlaywright(options?: BrowserStackProviderOptions): Promise<BrowserStackPlaywrightConnection>;
export function connectBrowserStackPuppeteer(options?: BrowserStackProviderOptions): Promise<BrowserStackBrowserConnection>;
export function connectBrowserStackSelenium(options?: BrowserStackProviderOptions): Promise<BrowserStackSeleniumConnection>;
export function inspectBrowserStackExtensionRuntime(connection: BrowserStackPlaywrightConnection | BrowserStackBrowserConnection): Promise<{
  extensionTargetCount: number;
  extensionTargets: Array<{ type: string; origin: string }>;
  extensionLoaded: boolean;
  diagnosticError?: unknown;
}>;
export function createBrowserStackSeleniumCapabilities(options?: BrowserStackProviderOptions): Record<string, unknown>;
export function credentialsFromOptions(options?: BrowserStackProviderOptions): BrowserStackCredentials;
export function resolveBrowserStackUploadMedia(options?: BrowserStackProviderOptions): BrowserStackExtensionRegistration;
export function uploadBrowserStackExtension(artifact: unknown, credentials: BrowserStackCredentials, options?: BrowserStackProviderOptions): string;
export function setBrowserStackSessionStatus(target: unknown, status: "passed" | "failed" | string, reason?: string): Promise<unknown>;
declare const api: unknown;
export default api;
