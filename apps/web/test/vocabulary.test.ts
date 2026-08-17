// @acceptance ACC-HARNESS ACC-OPS
import { capabilitySchema } from "@greenroom/contracts";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_TERMS,
  DELIVERY_STATE_TERMS,
  EMBED_VIEW_LABELS,
  REPORT_DATASET_LABELS,
  capabilityLabel,
  humanizeKey,
  proposalStatusLabel,
  proposalStatusTone,
} from "../src/ui/vocabulary";

describe("shared vocabulary", () => {
  it("names every capability the contract can issue", () => {
    // A capability the server grants and this map does not name is a checkbox on the API
    // client form labelled with a raw scope token — which is what shipped before it existed.
    expect(capabilitySchema.options.filter((scope) => !(scope in CAPABILITY_TERMS))).toEqual([]);
  });

  it("says what granting a capability lets somebody do", () => {
    for (const [scope, term] of Object.entries(CAPABILITY_TERMS)) {
      expect(term.label, scope).not.toMatch(/[:_]/);
      expect(term.consequence.endsWith("."), `${scope} consequence is a sentence`).toBe(true);
    }
    // The one that carries personal data out of the product has to be marked as such.
    expect(CAPABILITY_TERMS["reports:pii"].sensitive).toBe(true);
    expect(
      Object.entries(CAPABILITY_TERMS).filter(([, term]) => term.sensitive === true),
    ).toHaveLength(1);
  });

  it("keeps an unrecognised scope readable rather than raw", () => {
    expect(capabilityLabel("events:read")).toBe("Read events");
    expect(capabilityLabel("billing:manage")).toBe("Billing · manage");
  });

  it("lets an event's own status labels win over the shared floor", () => {
    expect(proposalStatusLabel("under_review")).toBe("Under review");
    expect(
      proposalStatusLabel("under_review", [{ key: "under_review", label: "With the committee" }]),
    ).toBe("With the committee");
    // An event may configure a status nothing here knows; it is spelled out, never printed raw.
    expect(proposalStatusLabel("shortlist_maybe")).toBe("Shortlist maybe");
    expect(humanizeKey("already_sent")).toBe("Already sent");
  });

  it("names a stopped delivery for what the reader has to do about it", () => {
    // "Terminal" is the storage word. The reader's question is whether anything will happen
    // on its own, and the answer is no.
    expect(DELIVERY_STATE_TERMS.terminal).toEqual({ label: "Stopped", tone: "danger" });
    expect(DELIVERY_STATE_TERMS.succeeded.tone).toBe("ok");
  });

  it("names every dataset and embed view a surface can offer", () => {
    expect(Object.values(REPORT_DATASET_LABELS).every((label) => /^[A-Z]/.test(label))).toBe(true);
    expect(EMBED_VIEW_LABELS.gallery).toBe("Speaker gallery");
    expect(proposalStatusTone("accepted")).toBe("ok");
    // A status this event invented has a name and no tone of its own.
    expect(proposalStatusTone("shortlist_maybe")).toBe("neutral");
  });
});
