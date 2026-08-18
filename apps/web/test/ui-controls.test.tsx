// @acceptance ACC-OPS
/*
 * The control tier's keyboard.
 *
 * These controls replace native elements that already worked without a mouse, so the keyboard
 * is the contract, not a refinement: a listbox that only opens on click is a regression from
 * the `<select>` it replaced. Every assertion below is a key a user presses and the answer the
 * widget is required to give — which option is active, where focus went, what the caller was
 * told — because none of that is observable from a service test and all of it is what the 73
 * converted selects and 21 converted date fields depend on.
 *
 * Two things are deliberately not asserted here. Native behaviour the platform owns — Space
 * toggling a checkbox, a label click forwarding to its input — is jsdom's to simulate and the
 * browser's to guarantee, so what is pinned instead is that the native element is still there
 * to do it. And visual state is CSS, which jsdom does not apply; the classes and ARIA that CSS
 * hangs off are asserted in its place.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Checkbox,
  Combobox,
  CopyableSecret,
  SegmentedControl,
  Select,
  type SelectOption,
} from "../src/ui/fields";
import { Menu } from "../src/ui/menu";

afterEach(cleanup);

const tracks: SelectOption[] = [
  { value: "main", label: "Main stage" },
  { value: "workshop", label: "Workshop room" },
  { value: "closed", label: "Closed for renovation", disabled: true },
  { value: "breakout", label: "Breakout B" },
];

function SelectHarness({ onChange }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState("main");
  return (
    <Select
      label="Track"
      value={value}
      options={tracks}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

function activeOptionText() {
  const active = document.querySelector('[data-active="true"]');
  return active?.textContent ?? null;
}

describe("Select", () => {
  it("opens on Enter, walks with the arrows, and commits to the caller", () => {
    const onChange = vi.fn();
    render(<SelectHarness onChange={onChange} />);
    const trigger = screen.getByLabelText("Track");

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    // Opening lands on the current value rather than on the top of the list.
    expect(activeOptionText()).toBe("Main stage");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(activeOptionText()).toBe("Workshop room");

    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("workshop");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // Focus returns to the trigger: the list it was in no longer exists.
    expect(document.activeElement).toBe(trigger);
  });

  it("steps over a disabled option instead of stalling on it", () => {
    render(<SelectHarness />);
    const trigger = screen.getByLabelText("Track");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(activeOptionText()).toBe("Workshop room");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(activeOptionText()).toBe("Breakout B");
  });

  it("jumps with Home and End and with type-ahead", () => {
    render(<SelectHarness />);
    const trigger = screen.getByLabelText("Track");
    fireEvent.keyDown(trigger, { key: "End" });
    expect(activeOptionText()).toBe("Breakout B");
    fireEvent.keyDown(trigger, { key: "Home" });
    expect(activeOptionText()).toBe("Main stage");
    fireEvent.keyDown(trigger, { key: "w" });
    expect(activeOptionText()).toBe("Workshop room");
  });

  it("closes on Escape, returns focus, and leaves the value alone", () => {
    const onChange = vi.fn();
    render(<SelectHarness onChange={onChange} />);
    const trigger = screen.getByLabelText("Track");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(trigger);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes when a pointer goes down outside it", () => {
    render(<SelectHarness />);
    const trigger = screen.getByLabelText("Track");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.mouseDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("reaches the first match and cycles on a repeated letter, as a native select does", () => {
    const rooms: SelectOption[] = [
      { value: "ballroom", label: "Ballroom" },
      { value: "balcony", label: "Balcony" },
      { value: "cellar", label: "Cellar" },
    ];
    render(<Select label="Room" value={null} options={rooms} onChange={vi.fn()} />);
    const trigger = screen.getByLabelText("Room");

    // Nothing is answered yet, so there is no current option to search past: the first "b"
    // has to land on the first option that starts with it.
    fireEvent.keyDown(trigger, { key: "b" });
    expect(activeOptionText()).toBe("Ballroom");

    // A repeated letter is the cycle through everything that starts with it, not a search for
    // "bb" that matches nothing and leaves the highlight where it was.
    fireEvent.keyDown(trigger, { key: "b" });
    expect(activeOptionText()).toBe("Balcony");
    fireEvent.keyDown(trigger, { key: "b" });
    expect(activeOptionText()).toBe("Ballroom");

    // A buffer nothing matches leaves the highlight where it is rather than jumping to the top
    // of the list. "bbb" plus a letter is "bbba", and no room begins with that.
    fireEvent.keyDown(trigger, { key: "a" });
    expect(activeOptionText()).toBe("Ballroom");
  });

  it("re-tests the option it has already reached as the buffer grows into a prefix", () => {
    const rooms: SelectOption[] = [
      { value: "ballroom", label: "Ballroom" },
      { value: "balcony", label: "Balcony" },
    ];
    render(<Select label="Room" value={null} options={rooms} onChange={vi.fn()} />);
    const trigger = screen.getByLabelText("Room");

    /*
     * The prefix branch, on its own: a single "b" searches from *past* the cursor, and every
     * letter after it searches from the cursor itself. Typing "ba" must therefore stay on the
     * Ballroom the "b" reached instead of walking on to Balcony, which is what a search that
     * always started one below would do — and what nothing here caught, because the assertion
     * that claimed to cover this appended a letter to a three-"b" cycle and so measured the
     * no-match branch instead: "bbba" matches nothing, and nothing is also what stays put.
     */
    fireEvent.keyDown(trigger, { key: "b" });
    expect(activeOptionText()).toBe("Ballroom");
    fireEvent.keyDown(trigger, { key: "a" });
    expect(activeOptionText()).toBe("Ballroom");
  });

  it("points assistive technology at nothing when there is nothing to point at", () => {
    render(<Select label="Round" value={null} options={[]} onChange={vi.fn()} />);
    const trigger = screen.getByLabelText("Round");

    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    // An `aria-activedescendant` naming an element that is not in the tree is a claim about
    // focus the popover cannot honour; the empty-state line is what has something to say.
    expect(trigger).not.toHaveAttribute("aria-activedescendant");
    expect(screen.getByText("Nothing to choose from yet.")).toBeInTheDocument();
  });

  it("lets go of the active option when the list it pointed into gets shorter", () => {
    const rooms: SelectOption[] = [
      { value: "main", label: "Main stage" },
      { value: "workshop", label: "Workshop room" },
      { value: "breakout", label: "Breakout B" },
    ];
    const { rerender } = render(
      <Select label="Room" value={null} options={rooms} onChange={vi.fn()} />,
    );
    const trigger = screen.getByLabelText("Room");
    fireEvent.keyDown(trigger, { key: "End" });
    expect(activeOptionText()).toBe("Breakout B");

    /*
     * A list can shrink under an open popover — a room withdrawn by a save on another screen, a
     * board reloaded while its picker is open. The cursor stays where the arrows left it, so the
     * id it names stops resolving: guarding on "the list is not empty" answered for a list that
     * emptied and not for one that merely got shorter, which is the same broken claim about
     * focus with two options still on screen to make it look fine.
     */
    rerender(<Select label="Room" value={null} options={rooms.slice(0, 1)} onChange={vi.fn()} />);

    const pointedAt = trigger.getAttribute("aria-activedescendant");
    expect(pointedAt === null || document.getElementById(pointedAt) !== null).toBe(true);
  });

  it("points assistive technology at the active option and marks the selected one", () => {
    render(<SelectHarness />);
    const trigger = screen.getByLabelText("Track");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const listbox = screen.getByRole("listbox", { name: "Track" });
    const active = document.querySelector('[data-active="true"]');
    expect(trigger).toHaveAttribute("aria-activedescendant", active?.id);
    expect(within(listbox).getByRole("option", { name: "Main stage" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(listbox).getByRole("option", { name: "Closed for renovation" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});

describe("Combobox", () => {
  it("filters as the user types and commits the active match on Enter", () => {
    const onChange = vi.fn();
    render(
      <Combobox
        label="Event timezone"
        value="UTC"
        options={[
          { value: "UTC", label: "UTC", hint: "UTC±00:00" },
          { value: "Europe/Madrid", label: "Europe/Madrid", hint: "UTC+02:00" },
          { value: "Europe/Madeira", label: "Europe/Madeira", hint: "UTC+01:00" },
        ]}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText("Event timezone");
    expect(input).toHaveValue("UTC");

    fireEvent.change(input, { target: { value: "madr" } });
    const listbox = screen.getByRole("listbox", { name: "Event timezone" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(1);

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("Europe/Madrid");
  });

  it("selects the answer it is showing, so a click and a keystroke filter", () => {
    render(
      <Combobox
        label="Event timezone"
        value="Europe/Madrid"
        options={[
          { value: "Europe/Madrid", label: "Europe/Madrid" },
          { value: "Asia/Kolkata", label: "Asia/Kolkata" },
        ]}
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByLabelText<HTMLInputElement>("Event timezone");
    input.focus();

    // Without this the caret lands where the pointer did and "asia" is spliced into the label
    // the box is showing, so the filter reads "Europe/Madridasia" and matches nothing.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Europe/Madrid".length);
  });

  it("selects the answer it is showing when the pointer is what focused it", () => {
    render(
      <Combobox
        label="Event timezone"
        value="Europe/Madrid"
        options={[
          { value: "Europe/Madrid", label: "Europe/Madrid" },
          { value: "Asia/Kolkata", label: "Asia/Kolkata" },
        ]}
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByLabelText<HTMLInputElement>("Event timezone");

    /*
     * The browser's own order for a mouse press, which the test above does not reproduce: focus
     * moves on the press, and the caret is placed from the pointer position *after* it. So a
     * selection made in `onFocus` alone is collapsed a moment later by the click that caused it,
     * and the fix that handler was written for — clicking "Europe/Madrid" and typing "asia"
     * filtering for "Europe/Madridasia" — was never actually fixed for the mouse.
     */
    input.focus();
    input.setSelectionRange("Europe/Madrid".length, "Europe/Madrid".length);
    fireEvent.click(input);

    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Europe/Madrid".length);

    // A caret placed inside a filter the reader is editing stays where they put it: re-selecting
    // on every click would make a typo impossible to correct with the mouse.
    fireEvent.change(input, { target: { value: "asia" } });
    input.setSelectionRange(2, 2);
    fireEvent.click(input);
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(2);
  });

  it("puts the selected label back when the filter is abandoned", () => {
    render(
      <Combobox
        label="Event timezone"
        value="UTC"
        options={[{ value: "UTC", label: "UTC" }]}
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByLabelText("Event timezone");
    fireEvent.change(input, { target: { value: "asia" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("UTC");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("Menu", () => {
  function MenuHarness({ onDuplicate = vi.fn(), onDelete = vi.fn() } = {}) {
    return (
      <Menu
        label="Session actions"
        items={[
          { id: "duplicate", label: "Duplicate", onSelect: onDuplicate },
          { id: "export", label: "Export", onSelect: vi.fn(), disabled: true },
          { id: "sep", separator: true },
          { id: "delete", label: "Delete", onSelect: onDelete, danger: true },
        ]}
      />
    );
  }

  it("opens downward onto the first item and upward onto the last", () => {
    render(<MenuHarness />);
    const trigger = screen.getByRole("button", { name: "Session actions" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Duplicate" }));

    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Duplicate" }), { key: "Escape" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
  });

  it("walks past a disabled item, wraps, and jumps with Home and End", () => {
    render(<MenuHarness />);
    const trigger = screen.getByRole("button", { name: "Session actions" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const duplicate = screen.getByRole("menuitem", { name: "Duplicate" });
    const remove = screen.getByRole("menuitem", { name: "Delete" });

    fireEvent.keyDown(duplicate, { key: "ArrowDown" });
    expect(document.activeElement).toBe(remove);
    fireEvent.keyDown(remove, { key: "ArrowDown" });
    expect(document.activeElement).toBe(duplicate);
    fireEvent.keyDown(duplicate, { key: "End" });
    expect(document.activeElement).toBe(remove);
    fireEvent.keyDown(remove, { key: "Home" });
    expect(document.activeElement).toBe(duplicate);
  });

  it("runs an item and gives focus back to the trigger", () => {
    const onDelete = vi.fn();
    render(<MenuHarness onDelete={onDelete} />);
    const trigger = screen.getByRole("button", { name: "Session actions" });
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("can be closed from the keyboard when no item can take focus", () => {
    // The default state of an unpublished call for proposals: every action names what it is
    // waiting for and none of them can be run yet.
    render(
      <Menu
        label="Call for proposals actions"
        items={[
          { id: "copy", label: "Copy public link", onSelect: vi.fn(), disabled: true },
          { id: "sep", separator: true },
          { id: "open", label: "Open public form", onSelect: vi.fn(), disabled: true },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Call for proposals actions" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "Call for proposals actions" });
    // A disabled button cannot be focused, so the menu itself holds focus rather than leaving
    // it on the trigger, where Escape is not answered by any item.
    expect(document.activeElement).toBe(menu);

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("answers Escape on the trigger too, since Enter and Space never reach an item", () => {
    render(
      <Menu
        label="Call for proposals actions"
        items={[{ id: "copy", label: "Copy public link", onSelect: vi.fn(), disabled: true }]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Call for proposals actions" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers no popover at all when there is nothing in it", () => {
    render(<Menu label="Row actions" items={[]} />);
    const trigger = screen.getByRole("button", { name: "Row actions" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    // A `role="menu"` owning no `menuitem` is an empty box with no required children, so the
    // trigger stays closed rather than presenting one.
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("places its popover against the viewport, out of any container that would clip it", () => {
    render(<MenuHarness />);
    const trigger = screen.getByRole("button", { name: "Session actions" });
    // A row-action trigger inside `.table-wrap`, whose `overflow-x: auto` makes it a scroll
    // container on both axes: an absolutely-positioned popover under this row is clipped by it.
    trigger.getBoundingClientRect = () =>
      ({ top: 100, bottom: 128, left: 40, right: 120, width: 80, height: 28 }) as DOMRect;

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "Session actions" });
    // Under the trigger, in viewport coordinates, so no ancestor's overflow can clip it.
    expect(menu.style.top).toBe("132px");
    expect(menu.style.left).toBe("40px");
  });

  it("closes on Escape and on an outside press, and declares itself to the reader", () => {
    render(<MenuHarness />);
    const trigger = screen.getByRole("button", { name: "Session actions" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Duplicate" }), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Checkbox", () => {
  function CheckboxHarness() {
    const [checked, setChecked] = useState(false);
    return (
      <Checkbox
        label="Notify the speaker"
        hint="Sends the acceptance email as soon as this is saved."
        checked={checked}
        onChange={setChecked}
      />
    );
  }

  it("keeps a real checkbox behind the drawn box, so the platform's keys still work", () => {
    render(<CheckboxHarness />);
    const input = screen.getByLabelText("Notify the speaker");
    expect(input).toHaveProperty("type", "checkbox");
    expect(input).not.toBeDisabled();

    // What Space does in a browser: activate the input. jsdom performs no default action for
    // the key, so the activation itself is what is driven here.
    fireEvent.click(input);
    expect(input).toBeChecked();
    fireEvent.click(input);
    expect(input).not.toBeChecked();
  });

  it("describes itself with its hint and carries the indeterminate state", () => {
    const { rerender } = render(
      <Checkbox label="Select all" checked={false} onChange={vi.fn()} indeterminate />,
    );
    const input = screen.getByLabelText("Select all");
    expect(input).toHaveProperty("indeterminate", true);

    rerender(<Checkbox label="Select all" checked onChange={vi.fn()} />);
    expect(screen.getByLabelText("Select all")).toHaveProperty("indeterminate", false);

    cleanup();
    render(<CheckboxHarness />);
    const described = screen.getByLabelText("Notify the speaker");
    const hintId = described.getAttribute("aria-describedby");
    expect(hintId).toBeTruthy();
    expect(document.getElementById(String(hintId))).toHaveTextContent("Sends the acceptance email");
  });
});

describe("SegmentedControl", () => {
  const scores: SelectOption[] = [
    { value: "1", label: "1" },
    { value: "2", label: "2" },
    { value: "3", label: "3" },
    { value: "4", label: "4" },
    { value: "5", label: "5" },
  ];

  function ScoreHarness({ onClear }: { onClear?: () => void }) {
    const [value, setValue] = useState<string | null>("3");
    return (
      <SegmentedControl
        label="Score"
        numeric
        value={value}
        options={scores}
        onChange={setValue}
        {...(onClear
          ? {
              onClear: () => {
                setValue(null);
                onClear();
              },
            }
          : {})}
      />
    );
  }

  const segment = (label: string) => screen.getByRole("radio", { name: label });

  it("moves and selects with the arrows, wrapping at both ends", () => {
    render(<ScoreHarness />);
    expect(segment("3")).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(segment("3"), { key: "ArrowRight" });
    expect(segment("4")).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(segment("4"));

    fireEvent.keyDown(segment("4"), { key: "ArrowRight" });
    fireEvent.keyDown(segment("5"), { key: "ArrowRight" });
    expect(segment("1")).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(segment("1"), { key: "ArrowLeft" });
    expect(segment("5")).toHaveAttribute("aria-checked", "true");
  });

  it("jumps with Home and End and answers a typed digit", () => {
    render(<ScoreHarness />);
    fireEvent.keyDown(segment("3"), { key: "Home" });
    expect(segment("1")).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(segment("1"), { key: "End" });
    expect(segment("5")).toHaveAttribute("aria-checked", "true");

    // A five-point score is typed far more often than it is arrowed to.
    fireEvent.keyDown(segment("5"), { key: "2" });
    expect(segment("2")).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(segment("2"));
  });

  it("is one tab stop, with the selected segment holding it", () => {
    render(<ScoreHarness />);
    expect(segment("3")).toHaveAttribute("tabindex", "0");
    for (const label of ["1", "2", "4", "5"])
      expect(segment(label)).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("radiogroup", { name: "Score" })).toBeInTheDocument();
  });

  it("clears only where clearing is offered", () => {
    render(<ScoreHarness />);
    fireEvent.keyDown(segment("3"), { key: "Backspace" });
    expect(segment("3")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: "Clear Score" })).toBeNull();

    cleanup();
    const onClear = vi.fn();
    render(<ScoreHarness onClear={onClear} />);
    fireEvent.keyDown(segment("3"), { key: "Backspace" });
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(segment("3")).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: "Clear Score" })).toBeNull();
  });

  it("keeps the tab stop when Clear removes itself under the press", () => {
    render(<ScoreHarness onClear={vi.fn()} />);
    const clear = screen.getByRole("button", { name: "Clear Score" });
    clear.focus();
    fireEvent.click(clear);

    // Clearing unmounts the button that was pressed, and focus left on `document.body` makes
    // the next Tab restart at the top of the page instead of moving to the next criterion.
    expect(screen.queryByRole("button", { name: "Clear Score" })).toBeNull();
    expect(document.activeElement).toBe(segment("1"));
    expect(segment("1")).toHaveAttribute("tabindex", "0");
  });
});

describe("CopyableSecret", () => {
  it("draws its copy button from the control tier, not from the console shell", () => {
    render(<CopyableSecret label="Confirmation reference" value="01JD8Q4M0V6ZC3XK2N7T5RB9WE" />);
    const copy = screen.getByRole("button", { name: "Copy Confirmation reference" });

    /*
     * This renders on the public call for proposals, beside the reference an anonymous
     * submitter is given for a proposal they cannot otherwise look up. `secondary` and `small`
     * are declared in styles/shell.css, which only `App.tsx` loads, so there the button matched
     * nothing and fell back to the operating system's own chrome. Which classes the tier
     * declares is checked against the stylesheet in design-foundation.test.tsx.
     */
    expect(copy).toHaveClass("control-button", "secret-copy");
    expect(copy.className).not.toMatch(/\b(?:btn|primary|secondary|ghost|danger|small)\b/);
  });
});
