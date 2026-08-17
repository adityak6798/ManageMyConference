/*
 * Action menus.
 *
 * Deliberately not a value picker: a menu runs commands — Duplicate, Export, Withdraw — and
 * has no selected state to show. The console had been reaching for a `<select>` when it wanted
 * one of these, which is why several rows offered an "Actions" dropdown that announced itself
 * to a screen reader as a combobox with a value it did not have.
 *
 * The pattern is WAI-ARIA's menu button. Focus moves into the menu when it opens, walks it
 * with the arrow keys, and returns to the trigger when it closes — including when an item
 * runs, because the row that spawned the menu is where the user was, and losing focus to the
 * document body after every action is what makes a keyboard user re-navigate the page.
 */

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { useDismissOnOutsidePointerDown } from "./fields";
import "../styles/controls.css";

export type MenuAction = {
  id: string;
  label: ReactNode;
  onSelect: () => void;
  /** A second line under the label: the consequence, or what the action needs. */
  hint?: string | undefined;
  disabled?: boolean | undefined;
  /** Destructive. Named in danger ink rather than given a red ground. */
  danger?: boolean | undefined;
};

export type MenuSeparator = { id: string; separator: true };

export type MenuEntry = MenuAction | MenuSeparator;

function isAction(entry: MenuEntry): entry is MenuAction {
  return !("separator" in entry);
}

/** The next selectable item in `step` direction, wrapping, or -1 when there is none. */
function nextIndex(actions: readonly MenuAction[], from: number, step: number) {
  const count = actions.length;
  if (count === 0) return -1;
  for (let offset = 0; offset < count; offset += 1) {
    const index = (((from + step * offset) % count) + count) % count;
    if (!actions[index]?.disabled) return index;
  }
  return -1;
}

export type MenuProps = {
  /** Names the menu and its trigger. A string, because a glyph trigger is named from it. */
  label: string;
  items: readonly MenuEntry[];
  /** Trigger content. Omitted, the trigger shows `label` and a chevron. */
  trigger?: ReactNode | undefined;
  /** Defaults to the console's secondary button. */
  triggerClassName?: string | undefined;
  /** `"end"` right-aligns the popover, for a trigger at the right edge of a row. */
  align?: "start" | "end" | undefined;
  disabled?: boolean | undefined;
};

export function Menu({
  label,
  items,
  trigger,
  triggerClassName = "secondary small",
  align = "start",
  disabled,
}: MenuProps) {
  const baseId = useId();
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const actions = items.filter(isAction);

  const dismiss = useCallback(() => setOpen(false), []);
  useDismissOnOutsidePointerDown(rootRef, open, dismiss);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[focusIndex]?.focus();
  }, [open, focusIndex]);

  function openMenu(from: "first" | "last") {
    const target =
      from === "first" ? nextIndex(actions, 0, 1) : nextIndex(actions, actions.length - 1, -1);
    setFocusIndex(target < 0 ? 0 : target);
    setOpen(true);
  }

  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  function run(action: MenuAction) {
    // Focus returns before the action runs: the action may unmount this row, and a focus call
    // afterwards would either fail silently or steal focus back from whatever replaced it.
    close(true);
    action.onSelect();
  }

  function onTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMenu("first");
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      openMenu("last");
    }
  }

  function onItemKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const key = event.key;
    if (key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (key === "Tab") {
      // Tab leaves the menu rather than cycling inside it: a menu is not a dialog, and the
      // page behind it is still live. Focus goes back to the trigger without preventing the
      // key, so the browser then tabs on from the trigger — tabbing from an item that this
      // same keystroke unmounts would drop focus to the document body instead.
      close(true);
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      const next = nextIndex(
        actions,
        index + (key === "ArrowDown" ? 1 : -1),
        key === "ArrowDown" ? 1 : -1,
      );
      if (next >= 0) setFocusIndex(next);
      return;
    }
    if (key === "Home" || key === "End") {
      event.preventDefault();
      const next =
        key === "Home" ? nextIndex(actions, 0, 1) : nextIndex(actions, actions.length - 1, -1);
      if (next >= 0) setFocusIndex(next);
    }
  }

  let actionIndex = -1;
  return (
    <div className="menu" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        id={`${baseId}-trigger`}
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${baseId}-menu` : undefined}
        aria-label={trigger ? label : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : openMenu("first"))}
        onKeyDown={onTriggerKeyDown}
      >
        {trigger ?? label}
      </button>
      {open ? (
        <div
          className={align === "end" ? "menu-popover is-end" : "menu-popover"}
          id={`${baseId}-menu`}
          role="menu"
          aria-label={label}
        >
          {items.map((entry) => {
            // An `<hr>` rather than a div with `role="separator"`: the element already carries
            // that role, and a role written by hand invites the "focusable separator" reading
            // of the spec that a menu divider is not.
            if (!isAction(entry)) return <hr key={entry.id} className="menu-separator" />;
            actionIndex += 1;
            const index = actionIndex;
            return (
              <button
                key={entry.id}
                type="button"
                role="menuitem"
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                className={entry.danger ? "menu-item is-danger" : "menu-item"}
                disabled={entry.disabled}
                tabIndex={index === focusIndex ? 0 : -1}
                onClick={() => run(entry)}
                onKeyDown={(event) => onItemKeyDown(event, index)}
              >
                {entry.label}
                {entry.hint ? <span className="menu-item-hint">{entry.hint}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
