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

import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
  /**
   * Defaults to the control tier's own button. A console class — `secondary small` — is a
   * choice a console surface can still make, and one no public surface may rely on: those
   * classes are declared in `styles/shell.css`, which only `App.tsx` loads.
   */
  triggerClassName?: string | undefined;
  /** `"end"` right-aligns the popover, for a trigger at the right edge of a row. */
  align?: "start" | "end" | undefined;
  disabled?: boolean | undefined;
};

export function Menu({
  label,
  items,
  trigger,
  triggerClassName = "control-button",
  align = "start",
  disabled,
}: MenuProps) {
  const baseId = useId();
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [placement, setPlacement] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const actions = items.filter(isAction);
  const anyEnabled = nextIndex(actions, 0, 1) >= 0;

  const dismiss = useCallback(() => setOpen(false), []);
  useDismissOnOutsidePointerDown(rootRef, open, dismiss);

  useEffect(() => {
    if (!open) return;
    /*
     * The popover takes focus itself when no item can hold it — an empty `items`, or every
     * action disabled, which is what an unpublished call for proposals renders. Focusing an
     * absent or disabled button is a no-op in a browser, so focus stayed on the trigger while
     * `role="menu"` was open, and Escape — which only the items answer — could not reach it:
     * the keyboard had no way to close a menu it had just opened.
     */
    const item = anyEnabled ? itemRefs.current[focusIndex] : null;
    (item ?? popoverRef.current)?.focus();
  }, [open, focusIndex, anyEnabled]);

  /*
   * The popover is placed in viewport coordinates rather than against its trigger.
   *
   * `position: absolute` put it inside whatever the trigger was in, and the row-action menus
   * this component replaced native selects with sit inside `.table-wrap` — a container whose
   * `overflow-x: auto` computes `overflow-y` to `auto` as well, so it clipped the menu opened
   * on the last row and silently gained a scrollbar nothing hinted at. No overflow value fixes
   * that: `visible` beside a scrolling axis computes back to `auto`, and `clip` would take the
   * table's horizontal scrolling with it. A fixed box is clipped by none of them, and being
   * measured means it can also flip above a trigger with no room beneath it.
   */
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      const anchor = triggerRef.current?.getBoundingClientRect();
      const popover = popoverRef.current;
      if (!anchor || !popover) return;
      const box = popover.getBoundingClientRect();
      // `--s-1`, the offset the popover used to take from `top: calc(100% + var(--s-1))`.
      const gap = 4;
      const below = anchor.bottom + gap;
      const above = anchor.top - gap - box.height;
      const edge = align === "end" ? anchor.right - box.width : anchor.left;
      const top = below + box.height > window.innerHeight && above >= 0 ? above : below;
      const left = Math.max(gap, Math.min(edge, window.innerWidth - box.width - gap));
      // The same two numbers keep the object they are already in. This runs from a capture-phase
      // scroll listener, so it answers every scroll anywhere in the document — a textarea, a
      // sidebar, a table on the other side of the page — and a fresh object each time is a new
      // value by identity, which re-renders the open menu on every frame of a scroll that never
      // moved its trigger.
      setPlacement((current) =>
        current && current.top === top && current.left === left ? current : { top, left },
      );
    }
    place();
    // Capture, so a scroll inside the table the trigger sits in moves the menu with its row
    // rather than leaving it hanging over a row that has scrolled away.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, align]);

  function openMenu(from: "first" | "last") {
    /*
     * An empty `items` opens nothing. A `role="menu"` that owns no `menuitem` is not a menu —
     * it is an empty box with no name to read and no required children — so the trigger stays
     * closed rather than presenting one. A caller with nothing to offer disables the trigger;
     * a caller whose actions are all *disabled* still opens, because each disabled item names
     * what it needs, and that is the answer the reader came for.
     */
    if (items.length === 0) return;
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
    // Escape is answered here as well as on the items, because Enter and Space call
    // `preventDefault`: with focus still on the trigger there is otherwise no key that closes
    // an open menu, and no click either, since the activation the trigger's `onClick` needs
    // was the default that was prevented.
    if (open && event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
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

  /** Escape and Tab for the popover itself, which holds focus when no item can. */
  function onPopoverKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Escape") event.preventDefault();
    if (event.key === "Escape" || event.key === "Tab") close(true);
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
          className="menu-popover"
          ref={popoverRef}
          id={`${baseId}-menu`}
          role="menu"
          aria-label={label}
          // Not a tab stop; a focus target for the case where no item is one.
          tabIndex={-1}
          style={placement ? { top: placement.top, left: placement.left } : undefined}
          onKeyDown={onPopoverKeyDown}
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
