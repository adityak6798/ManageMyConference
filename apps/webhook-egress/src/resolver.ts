import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { EgressError } from "./errors.js";
import { addressFamily, globallyRoutable } from "./ip.js";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface AddressResolver {
  resolve4(hostname: string): Promise<readonly string[]>;
  resolve6(hostname: string): Promise<readonly string[]>;
}

const DNS_TIMEOUT_MS = 1_500;

const absentAnswer = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENODATA" || code === "ENOTFOUND" || code === "ENODOMAIN";
};

const systemResolver = (): AddressResolver => {
  const resolver = new Resolver();
  return {
    resolve4: (hostname) => resolver.resolve4(hostname),
    resolve6: (hostname) => resolver.resolve6(hostname),
  };
};

/** Resolve both families and reject the complete set when one answer is not global. */
export async function resolveGlobalAddresses(
  hostname: string,
  resolver: AddressResolver = systemResolver(),
): Promise<readonly ResolvedAddress[]> {
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    if (!globallyRoutable(literal)) throw new EgressError("DNS_NOT_GLOBAL", "refused");
    return [{ address: literal, family: addressFamily(literal) }];
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new EgressError("DNS_RESOLUTION_FAILED", "retryable")),
      DNS_TIMEOUT_MS,
    );
  });
  let settled: PromiseSettledResult<readonly string[]>[];
  try {
    settled = await Promise.race([
      Promise.allSettled([resolver.resolve4(literal), resolver.resolve6(literal)]),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const answers: string[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled") answers.push(...result.value);
    else if (!absentAnswer(result.reason))
      throw new EgressError("DNS_RESOLUTION_FAILED", "retryable");
  }
  const unique = [...new Set(answers)].sort();
  if (unique.length === 0) throw new EgressError("DNS_NO_ANSWERS", "refused");
  if (unique.some((address) => !globallyRoutable(address)))
    throw new EgressError("DNS_NOT_GLOBAL", "refused");
  return unique.map((address) => ({ address, family: addressFamily(address) }));
}
