/*
 * The control tier.
 *
 * Every value a user picks in this product goes through one of these. They exist because the
 * console shipped 72 native `<select>` elements, 20 native date inputs, and native checkboxes
 * and radios with no `appearance` reset anywhere: controls the operating system drew, at
 * whatever height, weight and radius it felt like, next to controls the product drew. That
 * mismatch — not the palette — is what made the console read as a 2010s admin panel.
 *
 * Those are counted elements, not an estimate, and the conversion is unfinished: 41 native
 * selects and 21 native date and time inputs survive it, enumerated per file in `GAP-032`.
 * Count before repeating a number here — an earlier revision of this header said 73 and 21,
 * which is what a documentation sweep then propagated into four canonical files.
 *
 * Three rules hold across the file.
 *
 *  - The native element stays wherever it can still do the work. A checkbox is a real
 *    `<input type="checkbox">` with a drawn box beside it; a date field is a real
 *    `datetime-local` made invisible under a formatted display. What is drawn can then never
 *    disagree with what is submitted, and a surface's existing tests keep working.
 *  - Where the native element cannot be styled at all — the popup list of a `<select>` — it is
 *    replaced by the WAI-ARIA pattern in full, keyboard and screen reader behaviour included.
 *    A listbox that only works with a mouse is a regression, not a redesign.
 *  - Labelling, description, invalid state and error copy belong to `Field`, so alignment and
 *    `aria-describedby` wiring are automatic instead of hand-rolled on every surface.
 *
 * The stylesheet loads here rather than from `styles.css`, following `public-event/*`, so any
 * surface that renders a control gets the control tier with it — console, portal or public
 * page.
 */

import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import "../styles/controls.css";

/* ========================= shared bits ======================== */

function classes(...values: (string | false | null | undefined)[]) {
  return values.filter(Boolean).join(" ");
}

/**
 * Closes a popover when a pointer goes down anywhere outside it.
 *
 * `pointerdown` rather than `click`: a click fires after the press has already moved focus and
 * possibly scrolled, so a menu could still be open while the user is interacting with what is
 * underneath it. Exported because `ui/menu.tsx` owes its users the same behaviour.
 */
export function useDismissOnOutsidePointerDown(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onDismiss: () => void,
) {
  useEffect(() => {
    if (!active) return;
    function handle(event: PointerEvent | MouseEvent) {
      const target = event.target;
      if (target instanceof Node && ref.current?.contains(target)) return;
      onDismiss();
    }
    document.addEventListener("pointerdown", handle, true);
    // jsdom dispatches `mousedown` for `fireEvent.click` and has no PointerEvent of its own,
    // so both are listened for; a real browser fires pointerdown first and the second call
    // lands on an already-closed popover.
    document.addEventListener("mousedown", handle, true);
    return () => {
      document.removeEventListener("pointerdown", handle, true);
      document.removeEventListener("mousedown", handle, true);
    };
  }, [active, onDismiss, ref]);
}

/* Local glyphs. `ui/icons.tsx` belongs to another owner this phase, and these four are drawn
   at control scale (12–16px) rather than at the 24px grid that file is built on. */

function ChevronGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m2.5 4.5 3.5 3.5 3.5-3.5" />
    </svg>
  );
}

function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m2 6.3 2.6 2.6L10 3.5" />
    </svg>
  );
}

function DashGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
    >
      <path d="M2.5 6h7" />
    </svg>
  );
}

function DotGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="currentColor"
    >
      <circle cx="6" cy="6" r="3" />
    </svg>
  );
}

function CalendarGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3.5" width="12" height="10.5" rx="1.5" />
      <path d="M2 7h12M5.5 1.8v3M10.5 1.8v3" />
    </svg>
  );
}

function ClockGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8.3l2.3 1.4" />
    </svg>
  );
}

/* ============================ Field =========================== */

/**
 * What `Field` hands its control: identity, description wiring, and validity.
 *
 * Every member is a real DOM attribute, because the documented recipe is to spread this object
 * straight onto a native control. The caption's own id is *not* here — it arrives as the render
 * prop's second argument instead. It used to be a member, and spreading it produced "React does
 * not recognize the `labelId` prop on a DOM element" on every render of seven workspaces, each
 * of which had grown its own one-line helper to strip it back out again.
 */
export type FieldControl = {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
  required: boolean | undefined;
  disabled: boolean | undefined;
};

export type FieldMessage = ReactNode | readonly string[];

/** Several surfaces carry `errors: string[]` from their validators; both shapes render. */
function messageOf(error: FieldMessage): ReactNode {
  if (error === undefined || error === null || error === false) return null;
  if (Array.isArray(error)) return error.length ? error.join(" ") : null;
  return error as ReactNode;
}

export type FieldProps = {
  label: ReactNode;
  /** Sits above the control: what to type, not what went wrong. */
  hint?: ReactNode | undefined;
  /** Sits below it. A non-empty value also sets `aria-invalid` on the control. */
  error?: FieldMessage | undefined;
  id?: string | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  /**
   * `"label"` wires a real `<label for>`. `"group"` renders a plain caption instead, for a
   * composite — a radiogroup, a segmented control — that a `<label>` cannot legally point at.
   */
  labelAs?: "label" | "group" | undefined;
  /** Keeps the caption for assistive technology while a toolbar's layout carries it visually. */
  labelHidden?: boolean | undefined;
  className?: string | undefined;
  /**
   * `labelId` is the second argument, for a composite — a radiogroup, a segmented control, a
   * listbox trigger — that names itself with `aria-labelledby`. A control that is a single
   * native element ignores it and spreads the first argument alone.
   */
  children: ReactNode | ((control: FieldControl, labelId: string) => ReactNode);
};

/**
 * The scaffold every other control in this file composes into.
 *
 * It owns the id, the label, the hint, the error and the `aria-describedby` that ties them
 * together. Surfaces used to write that by hand — `id`, `${id}-hint`, `${id}-error`, an
 * `aria-invalid` someone remembered on 4 of 11 fields — which is why field spacing and error
 * placement drifted from form to form.
 */
export function Field({
  label,
  hint,
  error,
  id,
  required,
  disabled,
  labelAs = "label",
  labelHidden = false,
  className,
  children,
}: FieldProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const labelId = `${controlId}-label`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const message = messageOf(error);
  const describedBy =
    [hint ? hintId : null, message ? errorId : null].filter(Boolean).join(" ") || undefined;

  const control: FieldControl = {
    id: controlId,
    "aria-describedby": describedBy,
    "aria-invalid": message ? true : undefined,
    required: required || undefined,
    disabled: disabled || undefined,
  };

  const captionClass = classes("field-label", labelHidden && "visually-hidden");
  return (
    <div className={classes("field", className)}>
      {labelAs === "label" ? (
        <label className={captionClass} id={labelId} htmlFor={controlId}>
          {label}
        </label>
      ) : (
        <span className={captionClass} id={labelId}>
          {label}
        </span>
      )}
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {typeof children === "function" ? children(control, labelId) : children}
      {message ? (
        <p className="error-text" id={errorId}>
          {message}
        </p>
      ) : null}
    </div>
  );
}

/* ==================== listbox shared logic ==================== */

export type SelectOption = {
  value: string;
  label: string;
  /** A second line under the option: what the choice means, or the measure that separates it. */
  hint?: string | undefined;
  disabled?: boolean | undefined;
};

function firstEnabled(options: readonly SelectOption[], from: number, step: number) {
  for (let offset = 0; offset < options.length; offset += 1) {
    const index = (from + step * offset + options.length * options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

function optionElementId(baseId: string, index: number) {
  return `${baseId}-option-${index}`;
}

/** Keeps the active option inside the popover's scroll port as arrows walk a long list. */
function useScrollActiveIntoView(
  listRef: RefObject<HTMLElement | null>,
  activeIndex: number,
  open: boolean,
) {
  /* `activeIndex` arrives as an argument rather than as state declared here, so the rule reads
     it as an outer value. It is state in the caller, and it is exactly what must re-run this
     effect: every arrow key changes it, and nothing else moves the list. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeIndex is the caller's state.
  useEffect(() => {
    if (!open) return;
    // Found by attribute rather than by id: `useId` produces ids containing colons, which are
    // legal in HTML and illegal in a selector without escaping.
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    // jsdom implements no scrolling at all, and the option still exists either way.
    active?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, listRef, open]);
}

function OptionRow({
  option,
  id,
  selected,
  active,
  onCommit,
  onHover,
}: {
  option: SelectOption;
  id: string;
  selected: boolean;
  active: boolean;
  onCommit: () => void;
  onHover: () => void;
}) {
  /* `role="option"` may hold no control of its own, and a second tab stop inside a widget whose
     whole point is to have one is the defect rather than the fix. Arrow keys and Enter are
     handled by the combobox that owns this list. */
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox above owns the keyboard.
    <div
      id={id}
      role="option"
      tabIndex={-1}
      className={classes("select-option", active && "is-active")}
      aria-selected={selected}
      aria-disabled={option.disabled || undefined}
      data-active={active || undefined}
      onMouseMove={onHover}
      onClick={() => {
        if (!option.disabled) onCommit();
      }}
    >
      <span className="select-option-mark" aria-hidden="true">
        {selected ? <CheckGlyph /> : null}
      </span>
      <span className="select-option-label">{option.label}</span>
      {option.hint ? <span className="select-option-hint figure">{option.hint}</span> : null}
    </div>
  );
}

/* =========================== Select =========================== */

export type SelectProps = {
  label: ReactNode;
  value: string | null;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string | undefined;
  id?: string | undefined;
  name?: string | undefined;
  hint?: ReactNode | undefined;
  error?: FieldMessage | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  labelHidden?: boolean | undefined;
  /** `"sm"` is the 28px variant, for a toolbar row that sits inside a header. */
  size?: "md" | "sm" | undefined;
  className?: string | undefined;
};

/**
 * A value picker built as the WAI-ARIA select-only combobox.
 *
 * Focus never leaves the trigger: the list is driven by `aria-activedescendant`, which is what
 * lets a screen reader announce the option under the cursor without the popover having to
 * manage a focus ring of its own.
 *
 * The accessible name is the field's label alone, deliberately, rather than the label plus the
 * current value. A name that changes whenever the value changes makes every label-based query
 * and every "you are on…" announcement drift with the data; the value is the trigger's content
 * and is announced from there.
 */
export function Select({
  label,
  value,
  onChange,
  options,
  placeholder = "Select…",
  id,
  name,
  hint,
  error,
  required,
  disabled,
  labelHidden,
  size = "md",
  className,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const typed = useRef({ buffer: "", at: 0 });
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const dismiss = useCallback(() => setOpen(false), []);
  useDismissOnOutsidePointerDown(rootRef, open, dismiss);

  function openAt(index: number) {
    setActiveIndex(index < 0 ? 0 : index);
    setOpen(true);
  }

  function commit(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    close(true);
  }

  /**
   * Native `<select>` type-ahead: letters jump to the next option that starts with them.
   *
   * Two branches, as the platform and the WAI-ARIA pattern both have. A run of one repeated
   * letter cycles through everything beginning with it — "b", "b", "b" walks Ballroom, Balcony,
   * Ballroom — rather than searching for "bb" and matching nothing; any other buffer is a
   * prefix, and it re-tests the option already reached so that typing "ba" after "b" stays on
   * Ballroom instead of walking off it.
   *
   * The search is circular from the cursor rather than a scan of the whole list with the cursor
   * excluded. Excluding it skipped the first match whenever nothing was selected — the cursor
   * was clamped to index 0, so "b" from an unanswered field landed on Balcony, past the
   * Ballroom the reader was reaching for — and made a third option starting with the same
   * letter unreachable, because the scan always restarted at the top.
   */
  function typeAhead(key: string) {
    const now = Date.now();
    const buffer = now - typed.current.at > 700 ? key : typed.current.buffer + key;
    typed.current = { buffer, at: now };
    const cycling = buffer.length > 1 && [...buffer].every((char) => char === buffer[0]);
    const needle = (cycling ? key : buffer).toLowerCase();
    // -1 while nothing is selected and the list is closed: there is no current option to search
    // past, so the search starts at the top of the list rather than one below it.
    const cursor = open ? activeIndex : selectedIndex;
    const from = buffer.length === 1 || cycling ? cursor + 1 : cursor;
    let match = -1;
    for (let offset = 0; offset < options.length && match < 0; offset += 1) {
      const index = (((from + offset) % options.length) + options.length) % options.length;
      const option = options[index];
      if (option && !option.disabled && option.label.toLowerCase().startsWith(needle))
        match = index;
    }
    if (match < 0) return;
    setActiveIndex(match);
    setOpen(true);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const key = event.key;
    if (key === "Escape") {
      if (!open) return;
      event.preventDefault();
      close(true);
      return;
    }
    if (key === "Tab") {
      if (open) commitOnTab();
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      if (open) commit(activeIndex);
      else openAt(selectedIndex);
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      const step = key === "ArrowDown" ? 1 : -1;
      if (!open) {
        openAt(selectedIndex >= 0 ? selectedIndex : firstEnabled(options, 0, 1));
        return;
      }
      const next = firstEnabled(options, activeIndex + step, step);
      if (next >= 0) setActiveIndex(next);
      return;
    }
    if (key === "Home" || key === "End") {
      event.preventDefault();
      const next = key === "Home" ? firstEnabled(options, 0, 1) : firstEnabled(options, -1, -1);
      if (next < 0) return;
      setActiveIndex(next);
      setOpen(true);
      return;
    }
    if (key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      typeAhead(key);
    }
  }

  /** Tab commits what the list is pointing at, then lets focus move on, as a select does. */
  function commitOnTab() {
    const option = options[activeIndex];
    setOpen(false);
    if (option && !option.disabled && option.value !== value) onChange(option.value);
  }

  useScrollActiveIntoView(listRef, activeIndex, open);

  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      id={id}
      required={required}
      disabled={disabled}
      labelHidden={labelHidden}
      className={className}
    >
      {(control, labelId) => (
        <div className="select" ref={rootRef}>
          <button
            type="button"
            ref={triggerRef}
            id={control.id}
            className={classes("control", "select-trigger", size === "sm" && "is-sm")}
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            /* Named whether or not the list is mounted, the way every disclosure in this
               repository names the panel it owns: a collapsed widget's `aria-controls` is not
               followed by assistive technology, and the e2e helpers find the list through it. */
            aria-controls={`${control.id}-listbox`}
            aria-labelledby={labelId}
            aria-describedby={control["aria-describedby"]}
            aria-invalid={control["aria-invalid"]}
            aria-required={control.required}
            /* Guarded on the cursor being inside the list, the way `Combobox` below is: the id
               named here has to resolve to an option that exists, or the trigger is claiming an
               active descendant the tree does not have.

               `activeIndex < options.length` rather than `options.length > 0`, because the list
               can also shrink under an open popover — a room withdrawn by another screen, a
               reload while the picker is open — and the cursor stays where the arrows left it.
               The empty list is the same condition read at zero: nothing to point at, and the
               empty line below is what speaks for it. */
            aria-activedescendant={
              open && activeIndex < options.length
                ? optionElementId(baseId, activeIndex)
                : undefined
            }
            disabled={disabled}
            onClick={() => (open ? close(false) : openAt(selectedIndex))}
            onKeyDown={onKeyDown}
          >
            <span className={classes("select-value", !selected && "is-placeholder")}>
              {selected ? selected.label : placeholder}
            </span>
            <ChevronGlyph className="select-chevron" />
          </button>
          {open ? (
            // The popover is the scroll port and the listbox is inside it: a `role="listbox"`
            // may contain options and nothing else, so an empty-state line or a count would be
            // an unnamed child of a list that claims to hold only choices.
            <div className="select-popover" ref={listRef}>
              <div role="listbox" id={`${control.id}-listbox`} aria-labelledby={labelId}>
                {options.map((option, index) => (
                  <OptionRow
                    key={option.value}
                    option={option}
                    id={optionElementId(baseId, index)}
                    selected={option.value === value}
                    active={index === activeIndex}
                    onCommit={() => commit(index)}
                    onHover={() => setActiveIndex(index)}
                  />
                ))}
              </div>
              {options.length === 0 ? (
                <p className="select-empty" aria-live="polite">
                  Nothing to choose from yet.
                </p>
              ) : null}
            </div>
          ) : null}
          {name ? <input type="hidden" name={name} value={value ?? ""} /> : null}
        </div>
      )}
    </Field>
  );
}

/* ========================== Combobox ========================== */

export type ComboboxProps = Omit<SelectProps, "size"> & {
  /** Shown when the filter matches nothing. */
  emptyLabel?: string | undefined;
  /**
   * How many matches the popover draws at once. A 400-entry list is not scannable and does not
   * need to be in the DOM; the count line below the list says what is being held back.
   */
  maxVisible?: number | undefined;
};

/**
 * The filtering variant, for a list too long to scan — timezones, speakers, sessions.
 *
 * The textbox holds the filter, never the value. Blur and Escape put the selected option's
 * label back, so a half-typed filter can never be left on screen claiming to be the value,
 * which is the failure mode of every "editable" select this replaces.
 */
export function Combobox({
  label,
  value,
  onChange,
  options,
  placeholder = "Search…",
  id,
  name,
  hint,
  error,
  required,
  disabled,
  labelHidden,
  className,
  emptyLabel = "No matches",
  maxVisible = 60,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.value === value);

  const needle = (query ?? "").trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(needle) ||
        option.value.toLowerCase().includes(needle) ||
        (option.hint?.toLowerCase().includes(needle) ?? false),
    );
  }, [needle, options]);
  const visible = matches.slice(0, maxVisible);

  const dismiss = useCallback(() => {
    setOpen(false);
    setQuery(null);
  }, []);
  useDismissOnOutsidePointerDown(rootRef, open, dismiss);
  useScrollActiveIntoView(listRef, activeIndex, open);

  function commit(index: number) {
    const option = visible[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setQuery(null);
    setOpen(false);
    inputRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const key = event.key;
    if (key === "Escape") {
      if (!open) return;
      event.preventDefault();
      dismiss();
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(
          Math.max(
            0,
            visible.findIndex((option) => option.value === value),
          ),
        );
        return;
      }
      const step = key === "ArrowDown" ? 1 : -1;
      const next = firstEnabled(visible, activeIndex + step, step);
      if (next >= 0) setActiveIndex(next);
      return;
    }
    if (key === "Enter" && open) {
      event.preventDefault();
      commit(activeIndex);
      return;
    }
    // Home and End move the caret, as they must in a textbox. Tab closes without committing:
    // in an editable combobox the value changes on Enter or on click, never on leaving.
    if (key === "Tab" && open) dismiss();
  }

  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      id={id}
      required={required}
      disabled={disabled}
      labelHidden={labelHidden}
      className={className}
    >
      {(control, labelId) => (
        <div className="select" ref={rootRef}>
          <input
            ref={inputRef}
            id={control.id}
            type="text"
            role="combobox"
            className="control combobox-input"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={query ?? selected?.label ?? ""}
            disabled={disabled}
            aria-expanded={open}
            aria-controls={`${control.id}-listbox`}
            aria-autocomplete="list"
            aria-describedby={control["aria-describedby"]}
            aria-invalid={control["aria-invalid"]}
            // `aria-required`, not `required`: the textbox holds a filter, and native
            // validation would refuse an empty filter over an already-chosen value.
            aria-required={control.required}
            /* Inside the list, not merely a non-empty list: see `Select` above. Typing resets the
               cursor to 0, but nothing resets it when the options themselves are replaced. */
            aria-activedescendant={
              open && activeIndex < visible.length
                ? optionElementId(baseId, activeIndex)
                : undefined
            }
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
              setOpen(true);
            }}
            /* Arriving at the box selects what it is showing, so the first keystroke filters
               rather than splicing into the answer already given: on the timezone field, a caret
               left inside "Europe/Madrid" turns typing "asia" into a filter for
               "Europe/Madridasia" and the list goes empty.

               It takes both handlers, because focus alone never fixed the path it was written
               for. A press focuses the box and the click *then* places the caret from the pointer,
               so the selection `onFocus` made is collapsed a moment later and the mouse user —
               the only user who had the problem, since tabbing into a text input selects it
               already — still typed into the middle of the label. `onFocus` stays for the arrivals
               that are not a click: a tab, and `commit`, which focuses the input so a chosen label
               arrives selected and typing re-filters.

               The click selects only while the box is showing the value. Once a filter is being
               typed `query` is a string and the caret belongs to the reader, and re-selecting on
               every click would make a typo in a 400-entry filter impossible to correct with the
               mouse. */
            onFocus={(event) => event.target.select()}
            onClick={(event) => {
              setOpen(true);
              if (query === null) event.currentTarget.select();
            }}
            onKeyDown={onKeyDown}
          />
          {open ? (
            /*
              Abandoning a filter is handled by Escape, by Tab, and by the outside-pointerdown
              dismiss above — never by the textbox's own blur. A blur handler here would fire
              on the press that is on its way to an option and close the list out from under
              the click, which is the classic reason a "filterable select" needs a mouse to be
              pressed twice.
            */
            <div className="select-popover" ref={listRef}>
              <div role="listbox" id={`${control.id}-listbox`} aria-labelledby={labelId}>
                {visible.map((option, index) => (
                  <OptionRow
                    key={option.value}
                    option={option}
                    id={optionElementId(baseId, index)}
                    selected={option.value === value}
                    active={index === activeIndex}
                    onCommit={() => commit(index)}
                    onHover={() => setActiveIndex(index)}
                  />
                ))}
              </div>
              {visible.length === 0 ? (
                <p className="select-empty" aria-live="polite">
                  {emptyLabel}
                </p>
              ) : null}
              {matches.length > visible.length ? (
                <p className="select-count figure" aria-live="polite">
                  {visible.length} of {matches.length} — keep typing
                </p>
              ) : null}
            </div>
          ) : null}
          {name ? <input type="hidden" name={name} value={value ?? ""} /> : null}
        </div>
      )}
    </Field>
  );
}

/* ===================== checkbox and radio ===================== */

export type CheckboxProps = {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /**
   * The control's accessible name, when it cannot be the words printed beside it.
   *
   * A checkbox in a table normally names itself from its visible text, and that is the shape to
   * reach for. But a select-all prints "Select all" and means "select every abstract in this
   * view" — two words on screen, a sentence in the accessibility tree — and without a way to say
   * so, three surfaces hand-rolled the whole control out of the `.choice` classes to get at the
   * input's `aria-label`, one of them copying the tick glyph to do it. `aria-label` wins over the
   * associated `<label>` in the accessible-name computation, so the printed text stays printed.
   */
  ariaLabel?: string | undefined;
  hint?: ReactNode | undefined;
  /** Drawn as a dash. The DOM property is set imperatively because HTML has no attribute. */
  indeterminate?: boolean | undefined;
  disabled?: boolean | undefined;
  id?: string | undefined;
  name?: string | undefined;
  value?: string | undefined;
  className?: string | undefined;
};

/**
 * A real `<input type="checkbox">` under a drawn box.
 *
 * The input is clipped rather than replaced, so the label click target, Space, form
 * participation, `indeterminate` and the screen reader's own checkbox semantics are the
 * platform's and cannot drift. Only the 16px box and its glyph are ours.
 */
export function Checkbox({
  label,
  checked,
  onChange,
  ariaLabel,
  hint,
  indeterminate = false,
  disabled,
  id,
  name,
  value,
  className,
}: CheckboxProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const hintId = `${controlId}-hint`;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    /*
      The hint sits outside the `<label>`, deliberately. Anything inside a label is part of the
      control's accessible name, so a hint written there is read as one run-on sentence with the
      label — "Notify the speaker Sends the acceptance email as soon as this is saved, checkbox"
      — instead of as the description `aria-describedby` makes it.
    */
    <div className={classes("choice-field", className)}>
      <label className={classes("choice", disabled && "is-disabled")} htmlFor={controlId}>
        <input
          ref={inputRef}
          id={controlId}
          className="choice-input"
          type="checkbox"
          name={name}
          value={value}
          checked={checked}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="choice-box" aria-hidden="true">
          {indeterminate ? (
            <DashGlyph className="choice-glyph" />
          ) : (
            <CheckGlyph className="choice-glyph" />
          )}
        </span>
        <span className="choice-text">{label}</span>
      </label>
      {hint ? (
        <span className="choice-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export type RadioProps = {
  label: ReactNode;
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  hint?: ReactNode | undefined;
  disabled?: boolean | undefined;
  id?: string | undefined;
  className?: string | undefined;
};

/** One radio. Arrow-key movement inside a group is the browser's, via the shared `name`. */
export function Radio({
  label,
  name,
  value,
  checked,
  onChange,
  hint,
  disabled,
  id,
  className,
}: RadioProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const hintId = `${controlId}-hint`;
  return (
    // The hint stays outside the label, for the reason given in `Checkbox` above.
    <div className={classes("choice-field", className)}>
      <label className={classes("choice", disabled && "is-disabled")} htmlFor={controlId}>
        <input
          id={controlId}
          className="choice-input"
          type="radio"
          name={name}
          value={value}
          checked={checked}
          disabled={disabled}
          aria-describedby={hint ? hintId : undefined}
          onChange={() => onChange(value)}
        />
        <span className="choice-box is-radio" aria-hidden="true">
          <DotGlyph className="choice-glyph" />
        </span>
        <span className="choice-text">{label}</span>
      </label>
      {hint ? (
        <span className="choice-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export type RadioGroupProps = {
  label: ReactNode;
  name: string;
  value: string | null;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  hint?: ReactNode | undefined;
  error?: FieldMessage | undefined;
  disabled?: boolean | undefined;
  inline?: boolean | undefined;
  id?: string | undefined;
  className?: string | undefined;
};

/** A captioned set of radios. The caption is a `<span>`, because no `<label>` may own a group. */
export function RadioGroup({
  label,
  name,
  value,
  onChange,
  options,
  hint,
  error,
  disabled,
  inline,
  id,
  className,
}: RadioGroupProps) {
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      id={id}
      disabled={disabled}
      labelAs="group"
      className={className}
    >
      {(control, labelId) => (
        <div
          className={classes("choice-group", inline && "is-inline")}
          role="radiogroup"
          aria-labelledby={labelId}
          aria-describedby={control["aria-describedby"]}
          aria-invalid={control["aria-invalid"]}
        >
          {options.map((option) => (
            <Radio
              key={option.value}
              name={name}
              value={option.value}
              label={option.label}
              hint={option.hint}
              checked={option.value === value}
              disabled={disabled || option.disabled}
              onChange={onChange}
            />
          ))}
        </div>
      )}
    </Field>
  );
}

/* ====================== date and time ========================= */

const DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

const dayFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/**
 * Formats the value exactly as typed, in the zone the surface names.
 *
 * `date` and `datetime-local` values carry no offset, and this product reads them as wall
 * clock in the event's own timezone. Converting them through a `Date` in the reader's zone —
 * the obvious implementation — would move a 09:45 session to 17:45 for anyone abroad, which is
 * the class of bug the timezone field itself exists to prevent, so the parts are read
 * literally and only the weekday and month names come from `Intl`.
 */
function formatWallClock(value: string, kind: TemporalKind): string | null {
  if (!value) return null;
  if (kind === "time") return /^(\d{2}):(\d{2})/.test(value) ? value.slice(0, 5) : null;
  const parts = kind === "date" ? DATE_PARTS.exec(value) : DATE_TIME_PARTS.exec(value);
  if (!parts) return null;
  const [, year, month, day] = parts;
  const at = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  const date = dayFormat.format(at);
  return kind === "date" ? date : `${date} · ${parts[4]}:${parts[5]}`;
}

type TemporalKind = "datetime-local" | "date" | "time";

export type DateTimeFieldProps = {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  /** The zone the value is read in — shown beside it, and named to assistive technology. */
  timeZone?: string | undefined;
  hint?: ReactNode | undefined;
  error?: FieldMessage | undefined;
  id?: string | undefined;
  name?: string | undefined;
  min?: string | undefined;
  max?: string | undefined;
  step?: number | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  labelHidden?: boolean | undefined;
  placeholder?: string | undefined;
  className?: string | undefined;
};

function TemporalField({
  kind,
  label,
  value,
  onChange,
  timeZone,
  hint,
  error,
  id,
  name,
  min,
  max,
  step,
  required,
  disabled,
  labelHidden,
  placeholder,
  className,
}: DateTimeFieldProps & { kind: TemporalKind }) {
  const zoneId = useId();
  const formatted = formatWallClock(value, kind);
  const fallback = placeholder ?? (kind === "time" ? "Choose a time" : "Choose a date");

  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      id={id}
      required={required}
      disabled={disabled}
      labelHidden={labelHidden}
      className={className}
    >
      {(control) => (
        <div className={classes("control", "datetime", disabled && "is-disabled")}>
          {/*
            The native picker is kept and made invisible: it is the value's source of truth, it
            carries the label, it opens the platform's own calendar including the one on a
            phone, and it is what a test types into. It is simply not allowed to draw itself,
            because `datetime-local` renders at a different width, height and separator in
            every browser.
          */}
          <input
            id={control.id}
            className="datetime-native"
            type={kind}
            name={name}
            value={value}
            min={min}
            max={max}
            step={step}
            required={control.required}
            disabled={disabled}
            aria-invalid={control["aria-invalid"]}
            aria-describedby={
              [control["aria-describedby"], timeZone ? zoneId : null].filter(Boolean).join(" ") ||
              undefined
            }
            onChange={(event) => onChange(event.target.value)}
          />
          <span className="datetime-display" aria-hidden="true">
            <span className={classes("datetime-value", "figure", !formatted && "is-empty")}>
              {formatted ?? fallback}
            </span>
            {timeZone ? <span className="datetime-zone figure">{timeZone}</span> : null}
          </span>
          {kind === "time" ? (
            <ClockGlyph className="datetime-glyph" />
          ) : (
            <CalendarGlyph className="datetime-glyph" />
          )}
          {timeZone ? (
            <span className="visually-hidden" id={zoneId}>
              Times are in {timeZone}.
            </span>
          ) : null}
        </div>
      )}
    </Field>
  );
}

/** Date and time in one control, read in `timeZone`. */
export function DateTimeField(props: DateTimeFieldProps) {
  return <TemporalField {...props} kind="datetime-local" />;
}

/** A calendar day with no time of day. */
export function DateField(props: DateTimeFieldProps) {
  return <TemporalField {...props} kind="date" />;
}

/** A time of day with no date. */
export function TimeField(props: DateTimeFieldProps) {
  return <TemporalField {...props} kind="time" />;
}

/* ======================= copyable secret ====================== */

export type CopyableSecretProps = {
  /** A string, because the copy button is named from it. */
  label: string;
  value: string;
  hint?: ReactNode | undefined;
  id?: string | undefined;
  className?: string | undefined;
};

/**
 * A value that exists to be copied: a signing secret, a webhook URL, an API key.
 *
 * The clipboard can refuse — an insecure origin, a denied permission, a browser that never
 * shipped the API — and a copy button that silently does nothing is worse than no button. The
 * refusal is caught and answered with the value in a selectable input plus a line saying what
 * to do, so the value is always obtainable.
 */
export function CopyableSecret({ label, value, hint, id, className }: CopyableSecretProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "manual">("idle");
  const manualRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (status !== "manual") return;
    manualRef.current?.focus();
    manualRef.current?.select();
  }, [status]);

  async function copy() {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      setStatus("manual");
      return;
    }
    try {
      await clipboard.writeText(value);
      setStatus("copied");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus("idle"), 6000);
    } catch {
      // ERROR-INTENT: a refused clipboard is a permission answer, not a fault. It is reported
      // to the user as the manual path below rather than logged and swallowed.
      setStatus("manual");
    }
  }

  return (
    <Field label={label} hint={hint} id={id} labelAs="group" className={className}>
      {(_control, labelId) => (
        <>
          <div className="secret">
            <code className="secret-value figure">{value}</code>
            <button
              type="button"
              // `control-button`, not the console's `secondary small`: those classes live in
              // shell.css, which no public surface loads, and this button renders on the public
              // call for proposals beside an anonymous submitter's confirmation reference.
              className="control-button secret-copy"
              // ERROR-INTENT: `copy` settles every outcome into the status below — copied, or
              // the manual path — so it has no rejection left for a handler to receive.
              onClick={() => void copy()}
              aria-label={`Copy ${label}`}
            >
              {status === "copied" ? "Copied" : "Copy"}
            </button>
          </div>
          {status === "manual" ? (
            <input
              ref={manualRef}
              className="control secret-manual"
              type="text"
              readOnly
              value={value}
              aria-labelledby={labelId}
              onFocus={(event) => event.target.select()}
            />
          ) : null}
          {/*
            One region, always mounted, whose text changes — swapping a live region in when the
            first message arrives is the pattern assistive technology commonly misses.
          */}
          <p
            className={status === "idle" ? "visually-hidden" : `secret-status is-${status}`}
            role="status"
          >
            {status === "copied"
              ? `${label} copied.`
              : status === "manual"
                ? "This browser refused the clipboard. Select the value above and copy it."
                : ""}
          </p>
        </>
      )}
    </Field>
  );
}

/* ===================== segmented control ====================== */

export type SegmentedControlProps = {
  /** A string, because the clear button is named from it. */
  label: string;
  value: string | null;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  /**
   * Offering a clear is what makes clearing explicit: without it, a score once given can only
   * be changed, never withdrawn. Backspace and Delete clear too, when it is offered.
   */
  onClear?: (() => void) | undefined;
  clearLabel?: string | undefined;
  /** Sets the figures in mono and lets 1–5 be typed as well as arrowed to. */
  numeric?: boolean | undefined;
  hint?: ReactNode | undefined;
  error?: FieldMessage | undefined;
  id?: string | undefined;
  disabled?: boolean | undefined;
  labelHidden?: boolean | undefined;
  className?: string | undefined;
};

/**
 * A bounded choice shown in full: a view switcher, a 1–5 score, a three-way filter.
 *
 * It is a radiogroup, not a row of buttons, so it is one tab stop and the arrow keys move
 * within it — and so a screen reader says "2 of 5" instead of reading five unrelated buttons.
 * Inside a `<select>` these choices cost a popover to read and hide four answers out of five.
 */
export function SegmentedControl({
  label,
  value,
  onChange,
  options,
  onClear,
  clearLabel = "Clear",
  numeric = false,
  hint,
  error,
  id,
  disabled,
  labelHidden,
  className,
}: SegmentedControlProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const tabbableIndex = selectedIndex >= 0 ? selectedIndex : firstEnabled(options, 0, 1);

  function move(from: number, step: number) {
    const next = firstEnabled(options, from + step, step);
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    buttons.current[next]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const key = event.key;
    if (key === "ArrowRight" || key === "ArrowDown") {
      event.preventDefault();
      move(index, 1);
      return;
    }
    if (key === "ArrowLeft" || key === "ArrowUp") {
      event.preventDefault();
      move(index, -1);
      return;
    }
    if (key === "Home" || key === "End") {
      event.preventDefault();
      const next = key === "Home" ? firstEnabled(options, 0, 1) : firstEnabled(options, -1, -1);
      const option = options[next];
      if (!option) return;
      onChange(option.value);
      buttons.current[next]?.focus();
      return;
    }
    if (onClear && (key === "Backspace" || key === "Delete")) {
      event.preventDefault();
      onClear();
      return;
    }
    if (numeric && /^[0-9]$/.test(key)) {
      const target = options.findIndex((option) => option.value === key && !option.disabled);
      if (target < 0) return;
      event.preventDefault();
      onChange(key);
      buttons.current[target]?.focus();
    }
  }

  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      id={id}
      disabled={disabled}
      labelAs="group"
      labelHidden={labelHidden}
      className={className}
    >
      {(control, labelId) => (
        <div className="segmented-row">
          <div
            className="segmented"
            role="radiogroup"
            aria-labelledby={labelId}
            aria-describedby={control["aria-describedby"]}
            aria-invalid={control["aria-invalid"]}
          >
            {options.map((option, index) => (
              /* An `<input type="radio">` cannot be drawn as a filled segment, and this group
                 owns roving focus, Home/End and the digit keys itself rather than inheriting
                 the browser's radio behaviour. */
              // biome-ignore lint/a11y/useSemanticElements: a segment is a drawn radio.
              <button
                key={option.value}
                type="button"
                role="radio"
                ref={(node) => {
                  buttons.current[index] = node;
                }}
                className={classes("segmented-option", numeric && "is-numeric")}
                aria-checked={option.value === value}
                title={option.hint}
                disabled={disabled || option.disabled}
                tabIndex={index === tabbableIndex ? 0 : -1}
                onClick={() => onChange(option.value)}
                onKeyDown={(event) => onKeyDown(event, index)}
              >
                {option.label}
              </button>
            ))}
          </div>
          {onClear && value !== null ? (
            <button
              type="button"
              className="segmented-clear"
              onClick={() => {
                /* Focus is handed to the segment that will hold the group's tab stop before
                   the clear runs. Clearing sets the value to null, which is the condition this
                   button is rendered under, so the press unmounts the element it landed on and
                   focus falls to `document.body` — on the reviewer's evaluation card that means
                   the next Tab restarts at the top of the console instead of continuing to the
                   next criterion. The Backspace path never had the problem, because the segment
                   it is pressed on is still there afterwards. */
                buttons.current[firstEnabled(options, 0, 1)]?.focus();
                onClear();
              }}
              aria-label={`${clearLabel} ${label}`}
            >
              {clearLabel}
            </button>
          ) : null}
        </div>
      )}
    </Field>
  );
}
