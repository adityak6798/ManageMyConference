import { isIP } from "node:net";

const ipv4Number = (address: string): number | null => {
  if (isIP(address) !== 4) return null;
  return address
    .split(".")
    .map(Number)
    .reduce((value, octet) => value * 256 + octet, 0);
};

const ipv4In = (address: number, network: string, bits: number): boolean => {
  const start = ipv4Number(network);
  if (start === null) return false;
  const size = 2 ** (32 - bits);
  return address >= start && address < start + size;
};

/**
 * The deny list is intentionally broader than RFC1918: the current special-purpose registry is
 * not webhook destination space, even when a block is syntactically unicast.
 */
const forbiddenIpv4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

const parseIpv6 = (input: string): bigint | null => {
  if (isIP(input) !== 6) return null;
  const mappedAt = input.lastIndexOf(".");
  let value = input.toLowerCase();
  if (mappedAt >= 0) {
    const colonAt = value.lastIndexOf(":", mappedAt);
    const embedded = ipv4Number(value.slice(colonAt + 1));
    if (embedded === null) return null;
    value = `${value.slice(0, colonAt)}:${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const omitted = 8 - left.length - right.length;
  if (omitted < 0 || (halves.length === 1 && omitted !== 0)) return null;
  const groups = [...left, ...Array.from({ length: omitted }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  let result = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    result = (result << 16n) | BigInt(`0x${group}`);
  }
  return result;
};

const ipv6In = (address: bigint, network: string, bits: number): boolean => {
  const start = parseIpv6(network);
  if (start === null) return false;
  const shift = BigInt(128 - bits);
  return address >> shift === start >> shift;
};

/** Special-purpose subranges inside allocations that are otherwise eligible. */
const forbiddenIpv6 = [
  ["2001:db8::", 32], // Documentation.
  ["2620:4f:8000::", 48], // Direct-delegation AS112 service.
] as const;

/**
 * RIR allocations from IANA's global-unicast registry (snapshot 2025-10-10). Unlisted 2000::/3
 * space remains reserved, so an allocation must be added deliberately rather than silently
 * becoming a destination. IANA protocol/special allocations are excluded or denied above.
 */
const allocatedIpv6 = [
  ["2001:200::", 23],
  ["2001:400::", 23],
  ["2001:600::", 23],
  ["2001:800::", 22],
  ["2001:c00::", 23],
  ["2001:e00::", 23],
  ["2001:1200::", 23],
  ["2001:1400::", 22],
  ["2001:1800::", 23],
  ["2001:1a00::", 23],
  ["2001:1c00::", 22],
  ["2001:2000::", 19],
  ["2001:4000::", 23],
  ["2001:4200::", 23],
  ["2001:4400::", 23],
  ["2001:4600::", 23],
  ["2001:4800::", 23],
  ["2001:4a00::", 23],
  ["2001:4c00::", 23],
  ["2001:5000::", 20],
  ["2001:8000::", 19],
  ["2001:a000::", 20],
  ["2001:b000::", 20],
  ["2003::", 18],
  ["2400::", 12],
  ["2410::", 12],
  ["2600::", 12],
  ["2610::", 23],
  ["2620::", 23],
  ["2630::", 12],
  ["2800::", 12],
  ["2a00::", 12],
  ["2a10::", 12],
  ["2c00::", 12],
] as const;

/** Only allocated ordinary global unicast is eligible; mapped addresses use the IPv4 policy. */
export const globallyRoutable = (address: string): boolean => {
  const ipv4 = ipv4Number(address);
  if (ipv4 !== null) return !forbiddenIpv4.some(([network, bits]) => ipv4In(ipv4, network, bits));
  const ipv6 = parseIpv6(address);
  if (ipv6 === null) return false;
  if (ipv6 >> 32n === 0xffffn) {
    const embedded = Number(ipv6 & 0xffff_ffffn);
    return !forbiddenIpv4.some(([network, bits]) => ipv4In(embedded, network, bits));
  }
  return (
    allocatedIpv6.some(([network, bits]) => ipv6In(ipv6, network, bits)) &&
    !forbiddenIpv6.some(([network, bits]) => ipv6In(ipv6, network, bits))
  );
};

export const addressFamily = (address: string): 4 | 6 => {
  const family = isIP(address);
  if (family !== 4 && family !== 6) throw new Error("Resolved address is not an IP literal");
  return family;
};
