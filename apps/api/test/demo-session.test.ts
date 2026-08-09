// @acceptance ACC-HARNESS
import { expect, it } from "vitest";
import { createDemoSession, resolveDemoSession } from "../src/application/identity/demo-session";

it("rejects expired and tampered demo sessions", async () => {
  const token = await createDemoSession("organizer", "secret", 200);
  expect(await resolveDemoSession(token, "secret", 199)).toMatchObject({ id: "seed-organizer" });
  expect(await resolveDemoSession(token, "secret", 200)).toBeNull();
  expect(await resolveDemoSession(`${token}bad`, "secret", 199)).toBeNull();
});
