import type { AssetStoragePort } from "../../application/content/content-repository";

export interface R2BucketPort {
  put(
    key: string,
    value: Uint8Array,
    options: { httpMetadata: { contentType: string } },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

// @spec PRD-SPK-002
export class R2AssetStorage implements AssetStoragePort {
  constructor(private readonly bucket: R2BucketPort) {}
  async put(input: { key: string; contentType: string; bytes: Uint8Array }) {
    await this.bucket.put(input.key, input.bytes, {
      httpMetadata: { contentType: input.contentType },
    });
    return { key: input.key };
  }
  async delete(key: string) {
    await this.bucket.delete(key);
  }
}
