import type { AssetStoragePort } from "../../application/content/content-repository";

export class DeterministicAssetStorage implements AssetStoragePort {
  readonly objects = new Map<string, { contentType: string; bytes: Uint8Array }>();
  async put(input: { key: string; contentType: string; bytes: Uint8Array }) {
    this.objects.set(input.key, { contentType: input.contentType, bytes: input.bytes });
    return { key: input.key };
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}
