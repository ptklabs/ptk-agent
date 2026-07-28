export interface BrowserlessProviderOptions {
  env?: Record<string, string | undefined>;
  apiKey?: string;
  token?: string;
  endpoint?: string;
  extensionName?: string | string[];
  extensionNames?: string | string[];
  extensionId?: string | string[];
  extensionIds?: string | string[];
  timeoutMs?: number | string;
  timeoutSeconds?: number | string;
  connectTimeoutMs?: number | string;
  launch?: Record<string, unknown>;
  launchOptions?: Record<string, unknown>;
  playwright?: unknown;
  puppeteer?: unknown;
  chromium?: unknown;
  connectOptions?: Record<string, unknown>;
  contextOptions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BrowserlessCredentials {
  apiKey: string;
}

export interface BrowserlessEndpoint {
  wsEndpoint: string;
  endpoint: string;
  launch: Record<string, unknown>;
  timeoutMs: number;
  connectTimeoutMs: number;
  extensionNames: string[];
}

export interface BrowserlessEndpointInfo {
  endpoint: string;
  launch: Record<string, unknown>;
  timeoutMs: number;
  connectTimeoutMs: number;
  extensionNames: string[];
}

export interface BrowserlessPlaywrightConnection {
  browser: any;
  context: any;
  page: any;
  endpoint: BrowserlessEndpointInfo;
  framework: "playwright";
  close(): Promise<void>;
}

export interface BrowserlessPuppeteerConnection {
  browser: any;
  page: any;
  endpoint: BrowserlessEndpointInfo;
  framework: "puppeteer";
  close(): Promise<void>;
}

export function credentialsFromOptions(options?: BrowserlessProviderOptions): BrowserlessCredentials;
export function browserlessExtensionNames(options?: BrowserlessProviderOptions): string[];
export function browserlessTimeoutMs(options?: BrowserlessProviderOptions): number;
export function browserlessConnectTimeoutMs(timeoutMs: number, options?: BrowserlessProviderOptions): number;
export function browserlessLaunchOptions(options?: BrowserlessProviderOptions): Record<string, unknown>;
export function browserlessWsEndpoint(options?: BrowserlessProviderOptions): BrowserlessEndpoint;
export function browserlessResultsDir(framework: string, options?: BrowserlessProviderOptions): string;
export function browserlessValidationSummary(framework: string, options?: BrowserlessProviderOptions): unknown;
export function connectBrowserlessPlaywright(options?: BrowserlessProviderOptions): Promise<BrowserlessPlaywrightConnection>;
export function connectBrowserlessPuppeteer(options?: BrowserlessProviderOptions): Promise<BrowserlessPuppeteerConnection>;
export function validateOnlyEnabled(options?: BrowserlessProviderOptions): boolean;
declare const api: unknown;
export default api;
