import { formatSdkIdentity } from "@cherto/core";
import { VERSION } from "./version.js";

export interface SdkWrapperIdentity {
  name: string;
  version: string;
}

function detectBrowserRuntime(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return extractVersion(ua, "Edg", "edge");
  if (/OPR\//.test(ua)) return extractVersion(ua, "OPR", "opera");
  if (/Chrome\//.test(ua)) return extractVersion(ua, "Chrome", "chrome");
  if (/Firefox\//.test(ua)) return extractVersion(ua, "Firefox", "firefox");
  if (/Version\/(\S+).*Safari/.test(ua)) return extractVersion(ua, "Version", "safari");
  return undefined;
}

function extractVersion(ua: string, marker: string, name: string): string | undefined {
  const match = ua.match(new RegExp(`${marker}/(\\d+)`));
  return match ? `${name}/${match[1]}` : undefined;
}

/**
 * The `X-Cherto-SDK` header value. A `wrapper`, such as `@cherto/react`, leads, with
 * `browser/<version>` and the runtime in its extras.
 */
export function buildSdkIdentity(wrapper?: SdkWrapperIdentity): string {
  const runtime = detectBrowserRuntime();
  if (wrapper) {
    return formatSdkIdentity(wrapper.name, wrapper.version, [
      `browser/${VERSION}`,
      ...(runtime ? [runtime] : []),
    ]);
  }
  return formatSdkIdentity("browser", VERSION, runtime ? [runtime] : []);
}
