export interface TestMuProviderOptions {
  env?: Record<string, string | undefined>;
  username?: string;
  accessKey?: string;
  packageRoot?: string;
  cacheRoot?: string;
  extensionZip?: string;
  extensionVersion?: string;
  extension?: {
    id?: string | string[];
    ids?: string | string[];
    cloudUrl?: string | string[];
    cloudUrls?: string | string[];
    url?: string | string[];
    upload?: boolean | string;
    version?: string;
    extensionsDir?: string;
    [key: string]: unknown;
  };
  extensionId?: string | string[];
  extensionIds?: string | string[];
  extensionUrls?: string[];
  extensionsDir?: string;
  upload?: boolean | string;
  uploadUrl?: string;
  build?: string;
  name?: string;
  project?: string;
  capabilities?: Record<string, unknown>;
  lambdatestOptions?: Record<string, unknown>;
  ltOptions?: Record<string, unknown>;
  client?: unknown;
  [key: string]: unknown;
}

export interface TestMuCredentials {
  username: string;
  accessKey: string;
}

export interface TestMuExtensionRegistration {
  source: string;
  extensionIds: string[];
  uploadMethod?: 'sdk' | 'curl-fallback' | 'curl-sdk-unavailable' | string;
  cloudUrls?: string[];
  artifact?: unknown;
}

export interface TestMuConnection<TBrowser = unknown, TPage = unknown> {
  client: unknown;
  extension: TestMuExtensionRegistration;
  session: any;
  sessionInfo: Record<string, unknown>;
  sdkExtensionsDir: string;
  browser: TBrowser;
  page: TPage;
  framework: "playwright" | "puppeteer" | string;
  close(): Promise<void>;
  [key: string]: unknown;
}

export interface TestMuPlaywrightConnection extends TestMuConnection {
  framework: "playwright";
  context: unknown;
  connectMode: "cdp" | "playwright" | string;
  playwrightTransport: "cdp" | "playwright" | string;
  testMuSessionKind: "playwright-cdp" | "playwright-native" | string;
}

export interface TestMuSeleniumConnection {
  driver: any;
  remoteUrl: string;
  capabilities: Record<string, unknown>;
  framework: "selenium";
  close(): Promise<void>;
}

export function connectTestMuPlaywright(options?: TestMuProviderOptions): Promise<TestMuPlaywrightConnection>;
export function connectTestMuPuppeteer(options?: TestMuProviderOptions): Promise<TestMuConnection>;
export function connectTestMuSelenium(options?: TestMuProviderOptions): Promise<TestMuSeleniumConnection>;
export function credentialsFromOptions(options?: TestMuProviderOptions): TestMuCredentials;
export function createTestMuSeleniumCapabilities(options?: TestMuProviderOptions): Record<string, unknown>;
export function prepareTestMuUploadZip(options?: TestMuProviderOptions, sourceArtifact?: unknown): unknown;
export function uploadTestMuExtension(artifact: { path: string }, credentials: TestMuCredentials, options?: TestMuProviderOptions): string;
export function uploadTestMuExtensionWithFallback(client: any, artifact: { path: string }, credentials: TestMuCredentials, options?: TestMuProviderOptions): Promise<{
  cloudUrl: string;
  uploadMethod: 'sdk' | 'curl-fallback' | 'curl-sdk-unavailable' | string;
}>;
export function isTestMuSdkUploadFallbackError(error: unknown): boolean;
export function resolveTestMuBrowserCloudExtension(client: unknown, options?: TestMuProviderOptions): Promise<TestMuExtensionRegistration>;
export function createTestMuBrowserCloudSession(adapter: string, options?: TestMuProviderOptions): Promise<{
  client: unknown;
  extension: TestMuExtensionRegistration;
  session: any;
  sdkExtensionsDir: string;
}>;
export function releaseTestMuBrowserCloudSession(client: any, session: any, options?: TestMuProviderOptions): Promise<void>;
export function testMuSeleniumRemoteUrl(options?: TestMuProviderOptions): string;
declare const api: unknown;
export default api;
