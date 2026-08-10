// @acceptance ACC-HARNESS
import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/App";

afterEach(() => vi.unstubAllGlobals());

it("does not expose unknown exception details", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("database password leaked")));
  render(<App />);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Something went wrong");
  expect(alert).not.toHaveTextContent("database password");
});
