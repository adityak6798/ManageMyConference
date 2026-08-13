import type { WebhookSecretProtector } from "../../application/communications/webhook-security";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

/** AES-GCM envelope whose metadata selects a configured wrapping key during rotation. */
export class AesGcmWebhookSecretProtector implements WebhookSecretProtector {
  constructor(
    private readonly currentVersion: string,
    private readonly keys: ReadonlyMap<string, CryptoKey>,
  ) {}
  static async fromConfiguration(configuration: {
    currentVersion?: string;
    keyringJson?: string;
  }): Promise<AesGcmWebhookSecretProtector> {
    if (!configuration.currentVersion || !configuration.keyringJson)
      throw new Error("Webhook wrapping key configuration is missing");
    let parsed: unknown;
    try {
      parsed = JSON.parse(configuration.keyringJson);
    } catch {
      throw new Error("WEBHOOK_WRAPPING_KEYS must be a JSON object");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("WEBHOOK_WRAPPING_KEYS must be a JSON object");
    const keys = new Map<string, CryptoKey>();
    for (const [version, encoded] of Object.entries(parsed)) {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(version) || typeof encoded !== "string")
        throw new Error("Webhook wrapping keyring contains an invalid version or key");
      let raw: Uint8Array;
      try {
        raw = decode(encoded);
      } catch {
        throw new Error(`Webhook wrapping key ${version} is not base64`);
      }
      if (raw.byteLength !== 32)
        throw new Error(`Webhook wrapping key ${version} must decode to 32 bytes`);
      keys.set(
        version,
        await crypto.subtle.importKey(
          "raw",
          new Uint8Array(raw).buffer,
          { name: "AES-GCM" },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    }
    if (!keys.has(configuration.currentVersion))
      throw new Error("WEBHOOK_WRAPPING_KEY_VERSION is absent from WEBHOOK_WRAPPING_KEYS");
    return new AesGcmWebhookSecretProtector(configuration.currentVersion, keys);
  }
  async seal(plaintext: string, purpose: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = this.keys.get(this.currentVersion);
    if (!key) throw new Error("Current webhook wrapping key is unavailable");
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
      key,
      encoder.encode(plaintext),
    );
    return JSON.stringify({
      v: this.currentVersion,
      iv: encode(iv),
      ct: encode(new Uint8Array(ciphertext)),
    });
  }
  async open(envelope: string, purpose: string): Promise<string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(envelope);
    } catch {
      throw new Error("Webhook secret envelope is malformed");
    }
    if (!parsed || typeof parsed !== "object")
      throw new Error("Webhook secret envelope is malformed");
    const value = parsed as { v?: unknown; iv?: unknown; ct?: unknown };
    if (typeof value.v !== "string" || typeof value.iv !== "string" || typeof value.ct !== "string")
      throw new Error("Webhook secret envelope is malformed");
    const key = this.keys.get(value.v);
    if (!key) throw new Error(`Webhook wrapping key version ${value.v} is unavailable`);
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: decode(value.iv), additionalData: encoder.encode(purpose) },
        key,
        decode(value.ct),
      );
      return decoder.decode(plaintext);
    } catch {
      throw new Error("Webhook secret envelope authentication failed");
    }
  }
}
