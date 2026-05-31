type SentryScope = {
  setTag: (key: string, value: string) => void;
  setExtra: (key: string, value: unknown) => void;
};

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) {
    if (__DEV__) {
      console.log("[sentry] EXPO_PUBLIC_SENTRY_DSN not set — error reporting disabled");
    }
    initialized = true;
    return;
  }
  // Native SDK can be wired when @sentry/react-native is added to the project.
  if (__DEV__) {
    console.log("[sentry] DSN configured; install @sentry/react-native to enable native capture");
  }
  initialized = true;
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  initSentry();
  const message = error instanceof Error ? error.message : String(error);
  console.error("[sentry]", message, context ?? "");
}

export function captureMessage(message: string, level: "info" | "warning" | "error" = "info"): void {
  initSentry();
  const fn = level === "error" ? console.error : level === "warning" ? console.warn : console.log;
  fn(`[sentry] ${message}`);
}

export function withScope(_callback: (scope: SentryScope) => void): void {
  const scope: SentryScope = {
    setTag: () => {},
    setExtra: () => {},
  };
  _callback(scope);
}
