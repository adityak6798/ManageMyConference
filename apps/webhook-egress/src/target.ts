import type { LookupAddress } from "node:dns";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { LookupFunction } from "node:net";
import { EgressError } from "./errors.js";
import type { ResolvedAddress } from "./resolver.js";

const permittedHeaders = new Set([
  "content-type",
  "greenroom-signature",
  "greenroom-event-id",
  "greenroom-event-type",
  "greenroom-delivery-id",
  "x-correlation-id",
]);

export interface TargetRequest {
  url: URL;
  address: ResolvedAddress;
  headers: Readonly<Record<string, string>>;
  body: string;
  timeoutMs: number;
}

export const targetHeaders = (
  supplied: Readonly<Record<string, string>>,
  body: string,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(supplied)) {
    const normalized = name.toLowerCase();
    if (!permittedHeaders.has(normalized))
      throw new EgressError("TARGET_HEADER_REFUSED", "terminal");
    if (value.length > 8_192 || /[\r\n]/.test(value))
      throw new EgressError("TARGET_HEADER_REFUSED", "terminal");
    result[normalized] = value;
  }
  result["content-length"] = String(Buffer.byteLength(body));
  return result;
};

const pinnedLookup = ({ address, family }: ResolvedAddress): LookupFunction =>
  ((_hostname, options, callback) => {
    if (typeof options === "object" && options.all) {
      callback(null, [{ address, family }] satisfies LookupAddress[]);
      return;
    }
    callback(null, address, family);
  }) as LookupFunction;

/** Exposed for a regression test: URL host/SNI and socket address must be independent values. */
export const pinnedRequestOptions = (input: TargetRequest): RequestOptions => ({
  protocol: "https:",
  hostname: input.url.hostname.replace(/^\[|\]$/g, ""),
  port: input.url.port ? Number(input.url.port) : 443,
  path: `${input.url.pathname}${input.url.search}`,
  method: "POST",
  servername: input.url.hostname.replace(/^\[|\]$/g, ""),
  lookup: pinnedLookup(input.address),
  headers: targetHeaders(input.headers, input.body),
  agent: false,
  maxHeaderSize: 16 * 1024,
});

const nodeCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

/** Send no credential and retain no response bytes; status is the complete target result. */
export const sendPinned = async (input: TargetRequest): Promise<number> =>
  new Promise((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      action();
    };
    const request = httpsRequest(pinnedRequestOptions(input), (response) => {
      const status = response.statusCode;
      // ERROR-INTENT: target bodies are attacker-controlled and deliberately discarded. Destroying
      // the stream here bounds retained and transferred response bytes to the parsed headers.
      response.destroy();
      if (!status || status < 100 || status > 599)
        finish(() => reject(new EgressError("TARGET_MALFORMED_RESPONSE", "terminal")));
      else finish(() => resolve(status));
    });
    deadline = setTimeout(() => {
      request.destroy(new EgressError("TARGET_TIMEOUT", "retryable"));
    }, input.timeoutMs);
    request.on("error", (error) => {
      if (error instanceof EgressError) finish(() => reject(error));
      else if (nodeCode(error)?.startsWith("HPE_"))
        finish(() => reject(new EgressError("TARGET_MALFORMED_RESPONSE", "terminal")));
      else finish(() => reject(new EgressError("TARGET_UNREACHABLE", "retryable")));
    });
    request.end(input.body);
  });
