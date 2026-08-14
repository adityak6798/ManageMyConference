// @acceptance ACC-IDENTITY-EVENTS
/**
 * The cookie that says which sign-ins this browser has in flight (issue #166).
 *
 * The route cases in `http.test.ts` prove the behaviour end to end; these cover the edges a
 * two-tab journey never reaches — a cookie a caller wrote by hand, and more tabs than the cap.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_OUTSTANDING_ATTEMPTS,
  parseAttemptCookie,
  serializeAttemptCookie,
  withAttempt,
  withoutAttempt,
} from "../src/transport/http/oauth-attempt-cookie";

describe("outstanding sign-in attempts", () => {
  it("reads the ids a browser presents and drops anything that is not one", () => {
    expect(parseAttemptCookie(undefined)).toEqual([]);
    expect(parseAttemptCookie("")).toEqual([]);
    expect(parseAttemptCookie("a1~a2")).toEqual(["a1", "a2"]);
    // A cookie is caller-controlled input and these ids reach a bound parameter list, so
    // anything outside the id grammar is dropped rather than carried along.
    expect(parseAttemptCookie("a1~'; DROP TABLE users--~a2")).toEqual(["a1", "a2"]);
    expect(parseAttemptCookie(`${"x".repeat(65)}~a2`)).toEqual(["a2"]);
    // A repeat is one attempt, not two slots.
    expect(parseAttemptCookie("a1~a1~a2")).toEqual(["a1", "a2"]);
  });

  it("keeps the newest attempts when a browser opens more tabs than the cap", () => {
    let outstanding: string[] = [];
    for (let index = 1; index <= MAX_OUTSTANDING_ATTEMPTS + 2; index += 1)
      outstanding = withAttempt(outstanding, `a${index}`);
    expect(outstanding).toHaveLength(MAX_OUTSTANDING_ATTEMPTS);
    // The oldest lose their slot, because the oldest sign-in is the one most likely abandoned.
    expect(outstanding[0]).toBe("a3");
    expect(outstanding.at(-1)).toBe(`a${MAX_OUTSTANDING_ATTEMPTS + 2}`);
    // A cookie already over the cap is trimmed on the way in, so a caller cannot widen it.
    expect(parseAttemptCookie([...Array(20).keys()].map((n) => `a${n}`).join("~"))).toHaveLength(
      MAX_OUTSTANDING_ATTEMPTS,
    );
  });

  it("removes only the attempt a callback spent", () => {
    expect(withoutAttempt(["a1", "a2"], "a1")).toEqual(["a2"]);
    // A refusal that spent nothing leaves every tab's sign-in alone — the whole defect in #166.
    expect(withoutAttempt(["a1", "a2"], null)).toEqual(["a1", "a2"]);
    expect(withoutAttempt(["a1", "a2"], "a3")).toEqual(["a1", "a2"]);
    // Nothing outstanding serializes to nothing; the route clears the cookie rather than
    // writing an empty one.
    expect(serializeAttemptCookie(withoutAttempt(["a1"], "a1"))).toBe("");
    expect(serializeAttemptCookie(["a1", "a2"])).toBe("a1~a2");
  });
});
