import { timingSafeEqual } from "node:crypto";
import { type EgressCommand, executeCommand, parseCommand } from "./command.js";
import { EgressError } from "./errors.js";

const MAX_COMMAND_BYTES = 1024 * 1024;
const responseHeaders = { "cache-control": "no-store", "content-type": "application/json" };
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: responseHeaders });

const configuredTokens = (): readonly string[] =>
  [process.env.WEBHOOK_EGRESS_TOKEN, process.env.WEBHOOK_EGRESS_TOKEN_PREVIOUS].filter(
    (token): token is string => typeof token === "string" && token.length > 0,
  );

const authorized = (request: Request, tokens: readonly string[]): boolean => {
  const value = request.headers.get("authorization") ?? "";
  const left = Buffer.from(value);
  let matched = false;
  for (const token of tokens) {
    const right = Buffer.from(`Bearer ${token}`);
    matched = (left.length === right.length && timingSafeEqual(left, right)) || matched;
  }
  return matched;
};

const readJson = async (request: Request): Promise<unknown> => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_COMMAND_BYTES)
    throw new EgressError("COMMAND_TOO_LARGE", "refused");
  if (!request.body) throw new EgressError("COMMAND_INVALID", "refused");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_COMMAND_BYTES) {
      await reader.cancel();
      throw new EgressError("COMMAND_TOO_LARGE", "refused");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new EgressError("COMMAND_INVALID", "refused");
  }
};

const normalizedFailure = (command: EgressCommand | undefined, error: EgressError): Response => {
  if (error.disposition === "retryable") return json({ error: error.code }, 503);
  if (command?.operation === "dispatch")
    return json({
      result: "terminal",
      code: error.code === "DNS_NOT_GLOBAL" ? "DNS_REBIND_REFUSED" : error.code,
    });
  if (command?.operation === "validate") return json({ result: "refused", code: error.code });
  return json({ error: error.code }, error.code === "COMMAND_TOO_LARGE" ? 413 : 400);
};

/** Authenticated HTTP boundary for the separately deployed webhook enforcement service. */
export async function handleEgress(
  request: Request,
  tokens: readonly string[] = configuredTokens(),
) {
  const startedAt = performance.now();
  let command: EgressCommand | undefined;
  let outcome = "internal_error";
  let code: string | undefined;
  try {
    if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
    if (tokens.length === 0) return json({ error: "SERVICE_MISCONFIGURED" }, 503);
    if (!authorized(request, tokens)) return json({ error: "UNAUTHORIZED" }, 401);
    command = parseCommand(await readJson(request));
    const result = await executeCommand(command);
    outcome = result.result;
    code = "code" in result ? result.code : undefined;
    return json(result);
  } catch (error) {
    // ERROR-INTENT: Unexpected request errors may contain attacker-controlled target data; return only bounded errors.
    if (error instanceof EgressError) {
      outcome = error.disposition;
      code = error.code;
      return normalizedFailure(command, error);
    }
    return json({ error: "INTERNAL_ERROR" }, 500);
  } finally {
    // biome-ignore lint/suspicious/noConsole: structured telemetry contains no target or credential.
    console.info(
      JSON.stringify({
        level: "info",
        message: "webhook_egress.request",
        operation: command?.operation ?? "invalid",
        outcome,
        ...(code ? { code } : {}),
        durationMs: Math.round(performance.now() - startedAt),
      }),
    );
  }
}
