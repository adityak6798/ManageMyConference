// @acceptance ACC-CFP
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ParticipantsEditor } from "../src/cfp/ParticipantsEditor";

afterEach(cleanup);

describe("proposal participants", () => {
  it("adds, edits, assigns a role, and removes a structured participant", () => {
    const onChange = vi.fn();
    vi.spyOn(crypto, "randomUUID").mockReturnValue("10000000-0000-4000-8000-000000000099");
    const { rerender } = render(<ParticipantsEditor participants={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Add co-presenter" }));
    const added = onChange.mock.calls[0]?.[0];
    expect(added).toEqual([
      {
        id: "10000000-0000-4000-8000-000000000099",
        name: "",
        email: "",
        role: "co_speaker",
      },
    ]);

    rerender(<ParticipantsEditor participants={added} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Inez Invited" } });
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: "Inez Invited", role: "co_speaker" }),
    ]);
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "moderator" } });
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ role: "moderator" })]);
    fireEvent.click(screen.getByRole("button", { name: "Remove participant 1" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("enforces the configured maximum in the control", () => {
    const participants = Array.from({ length: 8 }, (_, index) => ({
      id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `Speaker ${index}`,
      email: `speaker-${index}@example.test`,
      role: "co_speaker" as const,
    }));
    render(<ParticipantsEditor participants={participants} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Add co-presenter" })).toBeDisabled();
    expect(screen.getByText("8 of 8 co-presenters added.")).toBeVisible();
  });
});
