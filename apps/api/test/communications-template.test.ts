// @acceptance ACC-INTEGRATION
// @spec PRD-COM-001
import { describe, expect, it } from "vitest";
import {
  TemplatePlaceholderError,
  TemplateValueError,
  renderTemplate,
} from "../src/domain/communications/template";

describe("template rendering", () => {
  it("substitutes every placeholder in the subject and the body", () => {
    const rendered = renderTemplate(
      {
        subject: "{{eventName}}: you're speaking",
        body: "Hello {{speakerName}}, see you at {{eventName}}.",
      },
      { speakerName: "Ada Lovelace", eventName: "Greenroom 2026" },
    );

    expect(rendered.subject).toBe("Greenroom 2026: you're speaking");
    expect(rendered.body).toBe("Hello Ada Lovelace, see you at Greenroom 2026.");
  });

  it("tolerates whitespace inside the braces and renders numbers and booleans", () => {
    const rendered = renderTemplate(
      { subject: null, body: "{{ sessionCount }} sessions. Confirmed: {{confirmed}}." },
      { sessionCount: 3, confirmed: true },
    );

    expect(rendered.subject).toBeNull();
    expect(rendered.body).toBe("3 sessions. Confirmed: true.");
  });

  it("refuses to send a message with an unfilled placeholder", () => {
    expect(() =>
      renderTemplate({ subject: null, body: "Hello {{speakerName}}" }, { speaker: "Ada" }),
    ).toThrow(TemplatePlaceholderError);
  });

  it.each(["{{speaker-name}}", "{{speaker name}}", "{{}}", "{{ }}"])(
    "notices %s rather than leaving braces in the message",
    (placeholder) => {
      // Payload keys are arbitrary strings, so a template author can write a placeholder that a
      // word-characters-only pattern would skip — and skipping it mails the braces.
      expect(() => renderTemplate({ subject: null, body: placeholder }, {})).toThrow(
        TemplatePlaceholderError,
      );
    },
  );

  it("fills a placeholder whose key is not a plain word", () => {
    expect(
      renderTemplate({ subject: null, body: "Hi {{speaker-name}}" }, { "speaker-name": "Ada" })
        .body,
    ).toBe("Hi Ada");
  });

  it("distinguishes a missing key from a key whose value is empty", () => {
    expect(renderTemplate({ subject: null, body: "[{{note}}]" }, { note: "" }).body).toBe("[]");
  });

  it("refuses a value that is not text or a number", () => {
    expect(() =>
      renderTemplate({ subject: null, body: "{{speaker}}" }, { speaker: { name: "Ada" } }),
    ).toThrow(TemplateValueError);
    expect(() => renderTemplate({ subject: null, body: "{{speaker}}" }, { speaker: null })).toThrow(
      TemplateValueError,
    );
  });

  it("inserts a value containing braces as literal text rather than expanding it again", () => {
    // The template author decides what a message can say. A payload value that looks like a
    // placeholder must not reach another field's value.
    const rendered = renderTemplate(
      { subject: null, body: "Talk: {{title}}" },
      { title: "On {{secret}} systems", secret: "classified" },
    );

    expect(rendered.body).toBe("Talk: On {{secret}} systems");
    expect(rendered.body).not.toContain("classified");
  });
});
