let _getToken: (() => Promise<string | null>) | null = null;

export function setAuthTokenGetter(fn: () => Promise<string | null>): void {
  _getToken = fn;
}

export async function getAuthToken(): Promise<string | null> {
  return _getToken ? _getToken() : null;
}
