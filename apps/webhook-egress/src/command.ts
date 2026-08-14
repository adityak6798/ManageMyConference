import { EgressError } from "./errors.js";
import { type AddressResolver, resolveGlobalAddresses } from "./resolver.js";
import { sendPinned, type TargetRequest } from "./target.js";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_HEADERS = 16;

export interface DispatchCommand {
  operation: "dispatch";
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  timeoutMs: number;
}

export interface ValidateCommand {
  operation: "validate";
  url: string;
}

export type EgressCommand = DispatchCommand | ValidateCommand;
export type TargetSender = (request: TargetRequest) => Promise<number>;

const parseUrl = (value: unknown): URL => {
  if (typeof value !== "string") throw new EgressError("URL_INVALID", "refused");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EgressError("URL_INVALID", "refused");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new EgressError("URL_INVALID", "refused");
  const port = url.port ? Number(url.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new EgressError("URL_INVALID", "refused");
  return url;
};

export const parseCommand = (value: unknown): EgressCommand => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new EgressError("COMMAND_INVALID", "refused");
  const record = value as Record<string, unknown>;
  const url = parseUrl(record.url).toString();
  if (record.operation === "validate") return { operation: "validate", url };
  if (record.operation !== "dispatch") throw new EgressError("COMMAND_INVALID", "refused");
  if (
    !record.headers ||
    typeof record.headers !== "object" ||
    Array.isArray(record.headers) ||
    Object.keys(record.headers).length > MAX_HEADERS ||
    Object.values(record.headers).some((header) => typeof header !== "string") ||
    typeof record.body !== "string" ||
    Buffer.byteLength(record.body) > MAX_BODY_BYTES ||
    !Number.isInteger(record.timeoutMs) ||
    Number(record.timeoutMs) < 100 ||
    Number(record.timeoutMs) > 10_000
  )
    throw new EgressError("COMMAND_INVALID", "refused");
  return {
    operation: "dispatch",
    url,
    headers: record.headers as Record<string, string>,
    body: record.body,
    timeoutMs: Number(record.timeoutMs),
  };
};

const targetResult = (status: number) => {
  if (status >= 200 && status <= 299) return { result: "delivered", targetStatus: status } as const;
  if (status >= 300 && status <= 399)
    return { result: "terminal", code: "TARGET_REDIRECT", targetStatus: status } as const;
  if (status === 408 || status === 425 || status === 429 || status >= 500)
    return { result: "retryable", code: `TARGET_${status}`, targetStatus: status } as const;
  return { result: "terminal", code: `TARGET_${status}`, targetStatus: status } as const;
};

export async function executeCommand(
  command: EgressCommand,
  dependencies: { resolver?: AddressResolver; send?: TargetSender } = {},
) {
  const url = new URL(command.url);
  const addresses = dependencies.resolver
    ? await resolveGlobalAddresses(url.hostname, dependencies.resolver)
    : await resolveGlobalAddresses(url.hostname);
  if (command.operation === "validate") return { result: "safe" } as const;
  // Resolution is fresh for this dispatch. The lookup callback below cannot perform DNS again.
  const random = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  const selected = addresses[random % addresses.length];
  if (!selected) throw new EgressError("DNS_NO_ANSWERS", "refused");
  try {
    return targetResult(
      await (dependencies.send ?? sendPinned)({
        url,
        address: selected,
        headers: command.headers,
        body: command.body,
        timeoutMs: command.timeoutMs,
      }),
    );
  } catch (error) {
    // ERROR-INTENT: Unknown provider errors may contain destination details; normalize them before returning.
    if (!(error instanceof EgressError))
      return { result: "retryable", code: "TARGET_UNREACHABLE" } as const;
    return {
      result: error.disposition === "refused" ? "terminal" : error.disposition,
      code: error.code,
    } as const;
  }
}
