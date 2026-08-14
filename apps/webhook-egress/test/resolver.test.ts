// @acceptance ACC-INTEGRATION
import { describe, expect, it } from "vitest";
import { type AddressResolver, resolveGlobalAddresses } from "../src/resolver.js";

const resolver = (ipv4: readonly string[], ipv6: readonly string[] = []): AddressResolver => ({
  async resolve4() {
    return ipv4;
  },
  async resolve6() {
    return ipv6;
  },
});

describe("resolveGlobalAddresses", () => {
  it("rejects an entire mixed safe/unsafe answer set", async () => {
    await expect(
      resolveGlobalAddresses(
        "receiver.example.com",
        resolver(["1.1.1.1", "10.0.0.8"], ["2606:4700:4700::1111"]),
      ),
    ).rejects.toMatchObject({ code: "DNS_NOT_GLOBAL" });
  });

  it("returns every unique A and AAAA answer", async () => {
    await expect(
      resolveGlobalAddresses(
        "receiver.example.com",
        resolver(["8.8.8.8", "1.1.1.1", "8.8.8.8"], ["2001:4860:4860::8888"]),
      ),
    ).resolves.toEqual([
      { address: "1.1.1.1", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
      { address: "8.8.8.8", family: 4 },
    ]);
  });

  it("refuses an empty set and transient resolver faults distinctly", async () => {
    await expect(resolveGlobalAddresses("none.example", resolver([]))).rejects.toMatchObject({
      code: "DNS_NO_ANSWERS",
    });
    await expect(
      resolveGlobalAddresses("fault.example", {
        async resolve4() {
          throw Object.assign(new Error("resolver unavailable"), { code: "ETIMEOUT" });
        },
        async resolve6() {
          return [];
        },
      }),
    ).rejects.toMatchObject({ code: "DNS_RESOLUTION_FAILED", disposition: "retryable" });
  });
});
