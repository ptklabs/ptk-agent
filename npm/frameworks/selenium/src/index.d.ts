export * from "../../../browser/src";

export interface PtkSeleniumDriverLike {
  get(url: string): Promise<void> | void;
  executeScript<T = unknown>(script: string | Function, ...args: unknown[]): Promise<T> | T;
  executeAsyncScript<T = unknown>(script: string | Function, ...args: unknown[]): Promise<T>;
  sleep?(ms: number): Promise<void>;
  switchTo?(): {
    frame?(frame: unknown): Promise<void> | void;
    defaultContent?(): Promise<void> | void;
  };
  manage?(): {
    setTimeouts?(timeouts: { script?: number }): Promise<void> | void;
  };
}

export function createSeleniumPageLike(driver: PtkSeleniumDriverLike, options?: object): import("../../../browser/src").PtkPageLike;
export function createSeleniumPtkBridge(driver: PtkSeleniumDriverLike, options?: object): import("../../../browser/src").PtkBridge;
export function waitForPtk(driver: PtkSeleniumDriverLike, options?: object): Promise<unknown>;
export function collectPtkResults(driverOrBridge: PtkSeleniumDriverLike | import("../../../browser/src").PtkBridge, session?: unknown, options?: object): Promise<unknown>;
export function withPtkScan<T>(
  driver: PtkSeleniumDriverLike,
  options: import("../../../browser/src").PtkScanOptions & { throwOnError: false },
  runJourney: (ctx: { driver: PtkSeleniumDriverLike; ptk: import("../../../browser/src").PtkBridge; session: unknown; startPtkScan: import("../../../browser/src").StartPtkScan }) => Promise<T>
): Promise<import("../../../browser/src").PtkScanResult<T>>;
export function withPtkScan<T>(
  driver: PtkSeleniumDriverLike,
  options: import("../../../browser/src").PtkScanOptions,
  runJourney: (ctx: { driver: PtkSeleniumDriverLike; ptk: import("../../../browser/src").PtkBridge; session: unknown; startPtkScan: import("../../../browser/src").StartPtkScan }) => Promise<T>
): Promise<import("../../../browser/src").PtkScanSuccess<T>>;

declare const api: {
  createSeleniumPageLike: typeof createSeleniumPageLike;
  createSeleniumPtkBridge: typeof createSeleniumPtkBridge;
  waitForPtk: typeof waitForPtk;
  bootstrapPtkPage: typeof import("../../../browser/src").bootstrapPtkPage;
  withPtkScan: typeof withPtkScan;
  collectPtkResults: typeof collectPtkResults;
};

export default api;
