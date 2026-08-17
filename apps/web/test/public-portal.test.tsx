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

/** The portal answering a real 400 envelope, keyed exactly as the transport keys it. */
function refuseWith(fieldErrors: Record<string, string[]>) {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/registrations") && init?.method === "POST")
      return Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "VALIDATION_FAILED",
              message: "Review the highlighted registration details.",
              correlationId: "ref-1",
              fieldErrors,
            },
          }),
          { status: 400 },
        ),
      );
    if (url.includes(`/api/public/sites/${SLUG}`))
      return Promise.resolve(new Response(JSON.stringify({ site }), { status: 200 }));
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
}

/** Everything the form asks for, so the submit reaches the server rather than the local guard. */
function completeTheForm() {
  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Pat Attendee" } });
  fireEvent.change(screen.getByLabelText(/Email/), { target: { value: "pat@example.com" } });
  const ticket = screen.getByRole("combobox", { name: /Ticket type/ });
  fireEvent.keyDown(ticket, { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: "Supporter" }));
  fireEvent.click(screen.getByLabelText(/I accept privacy notice version 3/));
}

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
  // derives the hover shade — and only the hover shade — from it on this same element.
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

/*
 * The required question, which the shared listbox no longer guards on the browser's behalf.
 *
 * A required `select` used to be a native one, so constraint validation blocked the submit and
 * focused it. The shared control is a `<button role="combobox">`, which constraint validation
 * cannot see, so an unanswered question went to the server and came back as "Review the
 * highlighted registration details." on a form that highlighted nothing.
 */
it("refuses an unanswered required question on the question, before asking the server", async () => {
  render(<PublicSiteApp />);
  await screen.findByRole("heading", { level: 1, name: "Harbor Collective" });

  fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Pat Attendee" } });
  fireEvent.change(screen.getByLabelText(/Email/), { target: { value: "pat@example.com" } });
  fireEvent.click(screen.getByLabelText(/I accept privacy notice version 3/));

  fireEvent.submit(screen.getByRole("button", { name: "Register" }));

  const ticket = await screen.findByRole("combobox", { name: /Ticket type/ });
  expect(await screen.findByText("Ticket type is required.")).toBeVisible();
  expect(ticket).toHaveAttribute("aria-invalid", "true");
  expect(ticket).toHaveFocus();
  // Nothing was asked of the server: the refusal is the browser's, as it was before.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(registration).toBeNull();

  // Answering it withdraws the refusal rather than leaving a message that is no longer true.
  fireEvent.keyDown(ticket, { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: "Supporter" }));
  expect(screen.queryByText("Ticket type is required.")).not.toBeInTheDocument();
});

it("puts the server's per-field refusal on the field it names", async () => {
  refuseWith({ diet: ["Dietary requirements is too long."] });
  render(<PublicSiteApp />);
  await screen.findByRole("heading", { level: 1, name: "Harbor Collective" });

  completeTheForm();
  fireEvent.submit(screen.getByRole("button", { name: "Register" }));

  // The banner says "highlighted", so something has to be highlighted.
  expect(await screen.findByText("Dietary requirements is too long.")).toBeVisible();
  expect(screen.getByLabelText(/Dietary requirements/)).toHaveAttribute("aria-invalid", "true");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Review the highlighted registration details.",
  );
});

/*
 * The three fields every portal has, which the highlight used to skip entirely.
 *
 * Only `site.registrationFields` was consulted, so a refusal naming `name`, `email` or `accepted`
 * — the built-in half of the submission, and the only half a portal with no custom questions has
 * at all — drew the banner over a form that highlighted nothing. `email` is not hypothetical:
 * "pat@localhost" and "pat@gmail" both satisfy the WHATWG `type=email` regex the browser enforces
 * and both fail `z.string().email()` on the server, so this is the ordinary typo path.
 */
it.each([
  ["email", "email", /Email/, "Enter a valid email address."],
  ["name", "name", /Name/, "Name is required."],
] as const)(
  "highlights the built-in %s field the server refused",
  async (_label, key, labelPattern, message) => {
    refuseWith({ [key]: [message] });
    render(<PublicSiteApp />);
    await screen.findByRole("heading", { level: 1, name: "Harbor Collective" });

    completeTheForm();
    fireEvent.submit(screen.getByRole("button", { name: "Register" }));

    expect(await screen.findByText(message)).toBeVisible();
    const control = screen.getByLabelText(labelPattern);
    expect(control).toHaveAttribute("aria-invalid", "true");
    // Described by the refusal, so the message reaches a reader who arrives at the control
    // rather than at the paragraph under it.
    expect(control).toHaveAccessibleDescription(message);
    // The banner keeps its sentence; the message is not repeated into it.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Review the highlighted registration details.",
    );
  },
);

it("highlights the consent tick the server refused", async () => {
  refuseWith({ accepted: ["Accept the privacy notice to register."] });
  render(<PublicSiteApp />);
  await screen.findByRole("heading", { level: 1, name: "Harbor Collective" });

  completeTheForm();
  fireEvent.submit(screen.getByRole("button", { name: "Register" }));

  expect(await screen.findByText("Accept the privacy notice to register.")).toBeVisible();
  const consent = screen.getByLabelText(/I accept privacy notice version 3/);
  expect(consent).toHaveAttribute("aria-invalid", "true");
  expect(consent).toHaveAccessibleDescription("Accept the privacy notice to register.");
});

/*
 * A refused answer arrives under its position in the submission, not under the question's key.
 *
 * `answers.diet` is what the transport actually sends — the Zod path joined with dots — and the
 * question's own lookup was for `diet`, so the one refusal the server raises about a custom
 * question was the one the highlight could never draw.
 */
it("lands a refused answer on the question it is about, under its payload path", async () => {
  refuseWith({ "answers.diet": ["Keep this under 2000 characters."] });
  render(<PublicSiteApp />);
  await screen.findByRole("heading", { level: 1, name: "Harbor Collective" });

  completeTheForm();
  fireEvent.submit(screen.getByRole("button", { name: "Register" }));

  expect(await screen.findByText("Keep this under 2000 characters.")).toBeVisible();
  expect(screen.getByLabelText(/Dietary requirements/)).toHaveAttribute("aria-invalid", "true");
});

/*
 * Nothing the envelope carries is dropped on the floor.
 *
 * A key with no control on the page — a body the server could not read at all, or an answer to a
 * question this portal has since stopped publishing — cannot be highlighted, so it is said in the
 * banner instead. Silently discarding it left the reader with a sentence pointing at nothing.
 */
it("folds a refusal with no control on the page into the banner", async () => {
  refuseWith({
    request: ["The submission could not be read."],
    "answers.withdrawn": ["That question is no longer offered."],
  });
  render(<PublicSiteApp />);
  await screen.findByRole("heading", { level: 1, name: "Harbor Collective" });

  completeTheForm();
  fireEvent.submit(screen.getByRole("button", { name: "Register" }));

  const banner = await screen.findByRole("alert");
  expect(banner).toHaveTextContent("The submission could not be read.");
  expect(banner).toHaveTextContent("That question is no longer offered.");
});

it("withdraws a built-in refusal once the reader edits the field it named", async () => {
  refuseWith({ email: ["Enter a valid email address."] });
  render(<PublicSiteApp />);
  await screen.findByRole("heading", { level: 1, name: "Harbor Collective" });

  completeTheForm();
  fireEvent.submit(screen.getByRole("button", { name: "Register" }));
  expect(await screen.findByText("Enter a valid email address.")).toBeVisible();

  fireEvent.change(screen.getByLabelText(/Email/), { target: { value: "pat@harbor.example" } });
  expect(screen.queryByText("Enter a valid email address.")).not.toBeInTheDocument();
  expect(screen.getByLabelText(/Email/)).not.toHaveAttribute("aria-invalid");
});

it("renders an unavailable portal as a page with a way on, not two lines of text", async () => {
  fetchMock.mockImplementation(() => Promise.resolve(new Response("{}", { status: 404 })));
  render(<PublicSiteApp />);

  expect(
    await screen.findByRole("heading", { level: 1, name: "This portal is not available" }),
  ).toBeVisible();
  expect(screen.getByRole("link", { name: "Greenroom" })).toHaveAttribute("href", "/");
});
