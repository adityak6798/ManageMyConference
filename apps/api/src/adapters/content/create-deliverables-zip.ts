import { zipSync } from "fflate";

export function createDeliverablesZip(
  files: readonly { name: string; bytes: Uint8Array }[],
): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name)))
    entries[file.name] = file.bytes;
  return zipSync(entries, { level: 0, mtime: new Date("1980-01-02T00:00:00.000Z") });
}
