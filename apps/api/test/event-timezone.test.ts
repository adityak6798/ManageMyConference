// @acceptance ACC-IDENTITY-EVENTS
/*
 * The timezone rule, pinned on both writers.
 *
 * It was written once, on `updateEventInputSchema`, and `POST /api/events` accepted anything
 * non-blank — `Definitely/NotAZone` created an event with 201. The two schemas are asserted
 * together here because that is the property that failed: one writer of a column validating and
 * the other not (#206).
 */
import {
  createEventInputSchema,
  resolveTimezone,
  TIMEZONE_REJECTED,
  updateEventInputSchema,
} from "@greenroom/contracts";
import { describe, expect, it } from "vitest";

/** Both writers of `events.timezone`, so neither can be hardened without the other. */
const writers = [
  {
    name: "createEventInputSchema",
    parse: (timezone: string) =>
      createEventInputSchema.safeParse({
        organizationId: "00000000-0000-4000-8000-000000000010",
        name: "Summit",
        timezone,
      }),
    read: (data: { timezone: string }) => data.timezone,
  },
  {
    name: "updateEventInputSchema",
    parse: (timezone: string) => updateEventInputSchema.safeParse({ name: "Summit", timezone }),
    read: (data: { timezone: string }) => data.timezone,
  },
] as const;

describe("event timezone", () => {
  for (const writer of writers) {
    describe(writer.name, () => {
      it("accepts a canonical IANA zone unchanged", () => {
        const parsed = writer.parse("Europe/Berlin");
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(writer.read(parsed.data)).toBe("Europe/Berlin");
      });

      it("refuses a string that is not a zone, naming the field", () => {
        const parsed = writer.parse("Definitely/NotAZone");
        expect(parsed.success).toBe(false);
        if (!parsed.success) {
          const issue = parsed.error.issues.find(({ path }) => path.join(".") === "timezone");
          expect(issue?.message).toBe(TIMEZONE_REJECTED);
        }
      });

      it("refuses a blank value", () => {
        expect(writer.parse("   ").success).toBe(false);
      });

      /*
       * What "not a zone" means, pinned by example, because the rule is now the runtime's:
       * these resolve to nothing under any reading, and each is a plausible typo rather than a
       * contrived string. `GMT+8` and `UTC+2` in particular *look* like the offsets accepted
       * below and are not spellings of anything.
       */
      it.each(["Banana", "America/Not_A_City", "GMT+8", "UTC+2", "Z", "05:30"])(
        "refuses %s, which resolves to no zone",
        (value) => {
          expect(writer.parse(value).success).toBe(false);
        },
      );

      /*
       * A fixed offset is accepted, and this is a deliberate reversal (#206 review). An earlier
       * rule refused them on the argument that an offset never observes a daylight transition,
       * so an event spanning one renders an hour wrong. That argument is sound and is now
       * guidance in the field description: it is about which zone an organizer should *want*,
       * not about which strings are zones — and regions with no daylight saving at all (India,
       * most of Arizona) are entitled to say so. Refusing them also narrowed accepted input on
       * an endpoint API clients already use, which the compatibility policy calls breaking.
       */
      it.each([
        ["+05:30", "+05:30"],
        ["-08:00", "-08:00"],
        ["+0530", "+05:30"],
        ["+05", "+05:00"],
      ])("accepts the fixed offset %s and stores it as %s", (input, stored) => {
        const parsed = writer.parse(input);
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(writer.read(parsed.data)).toBe(stored);
      });

      /*
       * `Intl` accepts an alias in any case and the value was stored verbatim, so the string
       * beside the event name stopped matching the id every other surface compares against.
       */
      it.each([
        ["utc", "UTC"],
        ["america/los_angeles", "America/Los_Angeles"],
        ["US/Pacific", "America/Los_Angeles"],
        ["EST5EDT", "America/New_York"],
        // A legacy abbreviation the runtime still understands. Worth pinning because it is the
        // exact value #206 reported an organizer typing, and it now lands somewhere sensible
        // rather than being stored verbatim or refused.
        ["PST", "America/Los_Angeles"],
      ])("canonicalizes %s to %s", (input, canonical) => {
        const parsed = writer.parse(input);
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(writer.read(parsed.data)).toBe(canonical);
      });
    });
  }

  it("defaults a create with no timezone rather than refusing it", () => {
    const parsed = createEventInputSchema.safeParse({
      organizationId: "00000000-0000-4000-8000-000000000010",
      name: "Summit",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.timezone).toBe("America/Los_Angeles");
  });

  describe("resolveTimezone", () => {
    it("answers null rather than throwing for anything that is not a zone", () => {
      expect(resolveTimezone("Definitely/NotAZone")).toBeNull();
      expect(resolveTimezone("")).toBeNull();
      expect(resolveTimezone("GMT+8")).toBeNull();
    });
    it("resolves a zone to the id the database uses", () => {
      expect(resolveTimezone(" Asia/Tokyo ")).toBe("Asia/Tokyo");
    });
    it("resolves a fixed offset rather than refusing it", () => {
      expect(resolveTimezone("+05:30")).toBe("+05:30");
    });

    /*
     * The property the picker depends on, asserted over the whole list rather than by sampling:
     * every zone the console can offer survives this function unchanged. Without it an organizer
     * could pick a name from the select and find a different id stored against their event, and
     * the picker would then not match its own value.
     */
    it("leaves every zone the picker can offer exactly as it is", () => {
      const offered = Intl.supportedValuesOf("timeZone");
      expect(offered.length).toBeGreaterThan(100);
      expect(offered.filter((zone) => resolveTimezone(zone) !== zone)).toEqual([]);
    });
  });
});
