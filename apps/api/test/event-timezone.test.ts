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
       * A fixed offset never observes a daylight transition, so an event stored as `+05:30`
       * renders an hour wrong on the public site, on the board and in every `.ics` invite from
       * the next transition onward — with no error anywhere. `Intl` accepts these, so the
       * refusal has to be ours.
       */
      it.each(["+05:30", "-08:00", "GMT+5", "UTC-3"])("refuses the fixed offset %s", (offset) => {
        expect(writer.parse(offset).success).toBe(false);
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
      expect(resolveTimezone("+05:30")).toBeNull();
    });
    it("resolves a zone to the id the database uses", () => {
      expect(resolveTimezone(" Asia/Tokyo ")).toBe("Asia/Tokyo");
    });
  });
});
