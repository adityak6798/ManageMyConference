import type { AssetStoragePort } from "../../application/content/content-repository";

export interface R2BucketPort {
  put(
    key: string,
    value: Uint8Array,
    options: { httpMetadata: { contentType: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{
    httpMetadata?: { contentType?: string };
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
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
  async get(key: string) {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return {
      // R2 does not guarantee stored metadata; fall back to an opaque type rather
      // than letting a browser sniff the bytes.
      contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      bytes: new Uint8Array(await object.arrayBuffer()),
    };
  }
  async delete(key: string) {
    await this.bucket.delete(key);
  }
}
