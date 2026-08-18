// @acceptance ACC-HARNESS
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/App";

// Unmounted before the stub is withdrawn. Testing Library's automatic cleanup is not registered in
// this workspace — `globals` is off, so it finds no `afterEach` to hook — which left the whole app
// mounted and reading while `vi.unstubAllGlobals()` put the real `fetch` back underneath it.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("does not expose unknown exception details", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("database password leaked")));
  render(<App />);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Something went wrong");
  expect(alert).not.toHaveTextContent("database password");
});
