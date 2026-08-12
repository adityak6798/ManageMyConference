// @acceptance ACC-SPEAKER
import { describe, expect, it } from "vitest";
import {
  sanitizeResourceEmbed,
  sanitizeResourceHtml,
} from "../src/adapters/content/sanitize-resource-html";
import { ResourceEmbedDeniedError } from "../src/application/content/content-service";

describe("speaker resource HTML security boundary", () => {
  it("strips scripts, event handlers, styles, and javascript URLs", () => {
    const clean = sanitizeResourceHtml(
      '<p onclick="steal()" style="background:url(x)">Hello<script>alert(1)</script><a href="javascript:alert(2)">link</a><img src=x onerror=steal()></p>',
    );
    expect(clean).toBe('<p>Hello<a rel="noopener noreferrer">link</a></p>');
    expect(clean).not.toMatch(/script|onclick|onerror|javascript|style/i);
  });

  it("keeps useful reference markup and hardens links", () => {
    expect(sanitizeResourceHtml('<h2>Guide</h2><a href="https://example.com">Read</a>')).toBe(
      '<h2>Guide</h2><a href="https://example.com" rel="noopener noreferrer">Read</a>',
    );
  });

  it("accepts one HTTPS iframe from an allowlisted host", () => {
    expect(
      sanitizeResourceEmbed(
        '<iframe src="https://docs.example.com/guide" onload="steal()"></iframe>',
        ["docs.example.com"],
      ),
    ).toBe('<iframe src="https://docs.example.com/guide"></iframe>');
  });

  it("refuses hostile and non-allowlisted embeds visibly", () => {
    expect(() =>
      sanitizeResourceEmbed('<iframe src="https://evil.example/x"></iframe>', ["docs.example.com"]),
    ).toThrow(ResourceEmbedDeniedError);
    expect(() => sanitizeResourceEmbed("<script>alert(1)</script>", ["docs.example.com"])).toThrow(
      ResourceEmbedDeniedError,
    );
  });
});
