export interface HyperbrowserProviderOptions {
  env?: Record<string, string | undefined>;
  apiKey?: string;
  baseUrl?: string;
  requestTimeoutMs?: number | string;
  packageRoot?: string;
  cacheRoot?: string;
  extensionZip?: string;
  extensionId?: string;
  extensionName?: string;
  extensionUploadCache?: string;
  sessionOptions?: Record<string, unknown>;
  clientOptions?: Record<string, unknown>;
  client?: any;
  Hyperbrowser?: any;
  playwright?: unknown;
  puppeteer?: unknown;
  chromium?: unknown;
  seleniumWebDriver?: any;
  seleniumChrome?: any;
  browserName?: string;
  chromeOptions?: any;
  capabilities?: Record<string, unknown>;
  scriptTimeoutMs?: number | string;
  connectOptions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HyperbrowserExtension {
  extensionId: string;
  source: 'env' | 'cache' | 'upload' | string;
  artifact?: unknown;
  name?: string;
  [key: string]: unknown;
}

export interface HyperbrowserPlaywrightConnection {
  readonly client: any;
  readonly session: any;
  extension: HyperbrowserExtension;
  sessionInfo: Record<string, unknown>;
  browser: any;
  context: any;
  page: any;
  framework: 'playwright';
  close(): Promise<void>;
}

export interface HyperbrowserPuppeteerConnection {
  readonly client: any;
  readonly session: any;
  extension: HyperbrowserExtension;
  sessionInfo: Record<string, unknown>;
  browser: any;
  page: any;
  framework: 'puppeteer';
  close(): Promise<void>;
}

export interface HyperbrowserSeleniumConnection {
  readonly client: any;
  readonly session: any;
  extension: HyperbrowserExtension;
  sessionInfo: Record<string, unknown>;
  driver: any;
  framework: 'selenium';
  close(): Promise<void>;
}

export const DEFAULT_API_BASE: string;
export const MAX_EXTENSION_BYTES: number;
export function assertHyperbrowserExtensionArtifact<T>(artifact: T): T;
export function hyperbrowserCredentials(options?: HyperbrowserProviderOptions): { apiKey: string };
export function createHyperbrowserClient(options?: HyperbrowserProviderOptions): any;
export function createHyperbrowserSeleniumDriver(session: any, options?: HyperbrowserProviderOptions): Promise<any>;
export function resolveHyperbrowserExtensionId(client: any, options?: HyperbrowserProviderOptions): Promise<HyperbrowserExtension>;
export function hyperbrowserSessionOptions(extensionId: string | string[], options?: HyperbrowserProviderOptions): Record<string, unknown>;
export function createHyperbrowserSessionWithExtension(options?: HyperbrowserProviderOptions): Promise<{ client: any; extension: HyperbrowserExtension; session: any }>;
export function stopHyperbrowserSession(client: any, session: any, options?: HyperbrowserProviderOptions): Promise<void>;
export function hyperbrowserHttpAgent(session: any): any;
export function hyperbrowserResultsDir(framework: string, options?: HyperbrowserProviderOptions): string;
export function hyperbrowserValidationSummary(framework: string, options?: HyperbrowserProviderOptions): unknown;
export function isHyperbrowserSeleniumReadinessError(error: unknown): boolean;
export function connectHyperbrowserPlaywright(options?: HyperbrowserProviderOptions): Promise<HyperbrowserPlaywrightConnection>;
export function connectHyperbrowserPuppeteer(options?: HyperbrowserProviderOptions): Promise<HyperbrowserPuppeteerConnection>;
export function connectHyperbrowserSelenium(options?: HyperbrowserProviderOptions): Promise<HyperbrowserSeleniumConnection>;
export function validateOnlyEnabled(options?: HyperbrowserProviderOptions): boolean;

declare const api: unknown;
export default api;
