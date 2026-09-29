const DEFAULT_SSR_FETCH_TIMEOUT_MS = 60_000;
const ENVIRONMENT_VARIABLE = "WARLOCK_SSR_FETCH_TIMEOUT_MS";

function isTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Resolves the development SSR module-fetch timeout, with the environment taking precedence. */
export function resolveSsrFetchTimeoutMs(option?: number): number {
  const environmentValue = process.env[ENVIRONMENT_VARIABLE];

  if (environmentValue !== undefined) {
    const parsed = Number(environmentValue);

    if (isTimeout(parsed)) return parsed;

    console.warn(
      `web: ${ENVIRONMENT_VARIABLE} must be a positive integer in milliseconds; received ${JSON.stringify(environmentValue)}. Using ${DEFAULT_SSR_FETCH_TIMEOUT_MS}ms.`,
    );
    return DEFAULT_SSR_FETCH_TIMEOUT_MS;
  }

  if (option === undefined || isTimeout(option)) return option ?? DEFAULT_SSR_FETCH_TIMEOUT_MS;

  console.warn(
    `web: ssrFetchTimeoutMs must be a positive integer in milliseconds; received ${JSON.stringify(option)}. Using ${DEFAULT_SSR_FETCH_TIMEOUT_MS}ms.`,
  );
  return DEFAULT_SSR_FETCH_TIMEOUT_MS;
}

/** Raised when Vite's development SSR module runner does not fetch a module in time. */
export class SsrModuleFetchTimeoutError extends Error {
  public constructor(
    public readonly moduleId: string,
    public readonly elapsedMs: number,
  ) {
    super(
      `Vite SSR module fetch for ${JSON.stringify(moduleId)} timed out after ${elapsedMs}ms; the host is likely overloaded (CPU). Raise ${ENVIRONMENT_VARIABLE} to allow more time.`,
    );
    this.name = "SsrModuleFetchTimeoutError";
  }
}

/** Bounds one Vite SSR module load and retains the module identity in a timeout failure. */
export function withSsrFetchTimeout<T>(
  moduleId: string | (() => string),
  load: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new SsrModuleFetchTimeoutError(typeof moduleId === "function" ? moduleId() : moduleId, Date.now() - startedAt));
    }, timeoutMs);
    timer.unref?.();
  });

  return Promise.race([load(), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
