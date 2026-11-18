/** The `X-Cherto-SDK` header value, e.g. `react/0.1.0 (browser/0.2.0; chrome/124)`. */
export function formatSdkIdentity(name: string, version: string, extras: string[] = []): string {
  const base = `${name}/${version}`;
  return extras.length > 0 ? `${base} (${extras.join("; ")})` : base;
}
