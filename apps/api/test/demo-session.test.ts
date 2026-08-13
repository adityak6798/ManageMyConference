// @acceptance ACC-HARNESS
import { expect, it } from "vitest";
import {
  createDemoSession,
  resolveDemoSession,
  resolveSeededDemoActor,
} from "../src/application/identity/demo-session";
import { createUserSession } from "../src/application/identity/real-auth";

it("rejects expired and tampered demo sessions", async () => {
  const token = await createDemoSession("organizer", "secret", 200);
  expect(await resolveDemoSession(token, "secret", 199, resolveSeededDemoActor)).toMatchObject({
    id: "seed-organizer",
  });
  expect(await resolveDemoSession(token, "secret", 200, resolveSeededDemoActor)).toBeNull();
  expect(await resolveDemoSession(`${token}bad`, "secret", 199, resolveSeededDemoActor)).toBeNull();
});

/**
 * The two grammars stay mutually unparseable, asserted from the demo side.
 *
 * One cookie name carries either credential on a demo deployment with Google configured, and
 * what makes that safe is the part count: a demo token is exactly three dot-separated parts and
 * a real session exactly two (`docs/architecture/authorization.md`). Adding the `sid` claim to
 * the session payload had to leave that alone, and a demo cookie must still resolve to nothing
 * as a session — which is also why signing out of a persona takes no session lookup.
 */
it("stays unparseable as a real session after the session id claim", async () => {
  const demo = await createDemoSession("organizer", "secret", 200);
  expect(demo.split(".")).toHaveLength(3);
  const real = await createUserSession("a-session-id", "seed-organizer", "secret", 200);
  expect(real.split(".")).toHaveLength(2);
  // And neither resolver reads the other's token.
  expect(await resolveDemoSession(real, "secret", 199, resolveSeededDemoActor)).toBeNull();
});
