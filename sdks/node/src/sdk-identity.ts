import { formatSdkIdentity } from "@cherto/core";
import { VERSION } from "./version.js";

/** Builds the `X-Cherto-SDK` header value, e.g. `node/0.4.0 (node/22.12.0)`. */
export function buildSdkIdentity(): string {
  return formatSdkIdentity("node", VERSION, [`node/${process.versions.node}`]);
}
