// @acceptance ACC-PUBLIC
/*
 * The anonymous portal's registration form.
 *
 * It had no coverage at all, which is part of how it came to be `className="stack"` — a class
 * with no matching rule in either stylesheet the portal loads — with eight bare label/input
 * pairs stacked flush against each other and a submit button falling through to whatever the
 * console's global button rule happened to be. These pin the structure it needs to keep: the
 * public shell, the shared form vocabulary, a labelled control per question, and the consent
 * stamp that has to travel with the registration.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicSiteApp } from "../src/PublicSiteApp";

const SLUG = "harbor-collective";

const site = {
  slug: SLUG,
  name: "Harbor Collective",
  tagline: "One programme, three events a year.",
  landing: { heading: "Harbor Collective", body: "Join us in Oakland." },
  login: { heading: "Register", body: "Tell us how to reach you." },
  theme: "light" as const,
  primaryColor: "#1d4ed8",
  programs: [
    {
      kind: "event-cfp" as const,
      ref: "greenroom-demo-summit",
      label: "Event",
      href: "/events/greenroom-demo-summit",
      title: "Greenroom Demo Summit",
      state: "Published",
    },
  ],
  pages: [{ slug: "code-of-conduct", title: "Code of conduct" }],
  privacyNotice: {
    version: 3,
    bodyHtml: "<p>We keep your address to send you the schedule.</p>",
    effectiveAt: "2026-07-01T00:00:00.000Z",
  },
  registrationFields: [
    {
      key: "diet",
      label: "Dietary requirements",
      kind: "text" as const,
      required: false,
      options: [],
      position: 0,
    },
    {
      key: "ticket",
      label: "Ticket type",
      kind: "select" as const,
      required: true,
      options: ["Standard", "Supporter"],
      position: 1,
    },
  ],
  publishedAt: "2026-08-01T00:00:00.000Z",
};

let fetchMock: ReturnType<typeof vi.fn>;
let registration: Record<string, unknown> | null = null;

beforeEach(() => {
  registration = null;
  window.history.replaceState({}, "", `/sites/${SLUG}`);
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/registrations") && init?.method === "POST") {
      registration = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            registered: true,
            noticeVersion: 3,
            acceptedAt: "2026-08-20T10:00:00.000Z",
          }),
          { status: 201 },
        ),
      );
    }
    if (url.includes(`/api/public/sites/${SLUG}`))
      return Promise.resolve(new Response(JSON.stringify({ site }), { status: 200 }));
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("wears the public shell and the shared form vocabulary", async () => {
  const { container } = render(<PublicSiteApp />);
  await screen.findByRole("heading", { level: 1, name: "Harbor Collective" });

  // The organization's own colour is the portal's one point of difference; public-pages.css
  // derives the hover shade and the tint from it on this same element.
  const shell = container.querySelector(".public-shell") as HTMLElement;
  expect(shell.style.getPropertyValue("--accent")).toBe("#1d4ed8");
  // `theme-light` matched no rule in any stylesheet the portal loads.
  expect(shell.className).toBe("public-shell");

  // Every question is a labelled control inside the form's own field vocabulary, rather than a
  // bare label/input pair with nothing separating it from the next.
  const form = container.querySelector("form.pub-form") as HTMLElement;
  expect(form.querySelectorAll(".pub-form-field").length).toBeGreaterThanOrEqual(4);
  expect(screen.getByLabelText(/Name/)).toBeRequired();
  expect(screen.getByLabelText(/Email/)).toHaveAttribute("type", "email");
  expect(screen.getByLabelText(/Dietary requirements/)).toHaveClass("control");
  // The select is the shared listbox, not a native one the console styles differently.
  expect(screen.getByRole("combobox", { name: /Ticket type/ })).toBeVisible();
  expect(form.querySelector("select")).toBeNull();
});

it("sends the answers and the consent stamp, and says which version was accepted", async () => {
  render(<PublicSiteApp />);
  await screen.findByRole("heading", { level: 1, name: "Harbor Collective" });

  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Pat Attendee" } });
  fireEvent.change(screen.getByLabelText(/Email/), { target: { value: "pat@example.com" } });
  fireEvent.change(screen.getByLabelText(/Dietary requirements/), { target: { value: "None" } });
  const ticket = screen.getByRole("combobox", { name: /Ticket type/ });
  fireEvent.keyDown(ticket, { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: "Supporter" }));
  fireEvent.click(screen.getByLabelText(/I accept privacy notice version 3/));

  fireEvent.submit(screen.getByRole("button", { name: "Register" }));

  await waitFor(() => expect(registration).not.toBeNull());
  expect(registration).toMatchObject({
    name: "Pat Attendee",
    email: "pat@example.com",
    accepted: true,
    answers: { diet: "None", ticket: "Supporter" },
  });
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Registered. You accepted privacy notice version 3.",
  );
});

it("renders an unavailable portal as a page with a way on, not two lines of text", async () => {
  fetchMock.mockImplementation(() => Promise.resolve(new Response("{}", { status: 404 })));
  render(<PublicSiteApp />);

  expect(
    await screen.findByRole("heading", { level: 1, name: "This portal is not available" }),
  ).toBeVisible();
  expect(screen.getByRole("link", { name: "Greenroom" })).toHaveAttribute("href", "/");
});
