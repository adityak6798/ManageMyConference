/*
 * Shared page furniture.
 *
 * Every workspace is assembled from these so a new surface never invents its own
 * chrome, and so fixes to focus handling, empty states, or announcement behaviour
 * land everywhere at once.
 *
 * Two rules decide what belongs here and what a region looks like:
 *
 * 1. Structure before containers. `Section` is the default page region — a label, a line of
 *    description, and content. `Card` is for one distinct object or state, and is the
 *    exception. docs/product/design-language.md has said this since the beginning; until
 *    `Section` existed, `Card` was the only region component and the rule was unimplementable.
 * 2. A row that carries a measure carries it in the cue gutter — one 56px monospace column
 *    down the left edge, behind a hairline spine that does not break between rows. A row with
 *    no measure has no gutter, which is why `GutterRow` cannot be rendered without one.
 */

import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { ApiFailure } from "../api/config";
import { useLinkProps } from "../router";
import { IconCheck, IconInfo, IconShield, IconWarning } from "./icons";

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="titles">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {subtitle ? <p className="subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}

/**
 * The default page region: a label, one grey line of description, and content.
 *
 * No border, no background, no radius, no shadow — the heading and the space around it are
 * the structure. Reach for `Card` only when the region is one distinct object or state.
 */
export function Section({
  title,
  description,
  actions,
  children,
  labelledBy,
  className,
  level = "h2",
}: {
  title?: ReactNode;
  /** One line. Anything longer is content, not a description. */
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  labelledBy?: string;
  className?: string;
  level?: "h2" | "h3";
}) {
  const Heading = level;
  return (
    <section
      className={className ? `section ${className}` : "section"}
      aria-labelledby={labelledBy}
    >
      {title || actions ? (
        <header className="section-head">
          <div className="section-titles">
            {title ? <Heading id={labelledBy}>{title}</Heading> : null}
            {description ? <p className="section-description">{description}</p> : null}
          </div>
          {actions ? <div className="actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="section-body">{children}</div>
    </section>
  );
}

/**
 * One distinct object or state — a record being edited, a single result, a panel that stands
 * apart from the page. A card is not a default page wrapper; that is what `Section` is for.
 */
export function Card({
  title,
  hint,
  actions,
  children,
  tight,
  labelledBy,
}: {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  tight?: boolean;
  labelledBy?: string;
}) {
  return (
    <section className="card" aria-labelledby={labelledBy}>
      {title ? (
        <header>
          <div>
            <h2 id={labelledBy}>{title}</h2>
            {hint ? <p className="hint">{hint}</p> : null}
          </div>
          {actions ? <div className="actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={tight ? "card-body tight" : "card-body"}>{children}</div>
    </section>
  );
}

export type TabItem = { id: string; label: string; count?: number };

/** Tabs follow the WAI-ARIA pattern: arrow keys move between tabs, not Tab. */
export function Tabs({
  items,
  active,
  onSelect,
  label,
}: {
  items: TabItem[];
  active: string;
  onSelect: (id: string) => void;
  label: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={`tab-${item.id}`}
          className="tab"
          aria-selected={item.id === active}
          aria-controls={`panel-${item.id}`}
          tabIndex={item.id === active ? 0 : -1}
          ref={(node) => {
            refs.current[item.id] = node;
          }}
          onClick={() => onSelect(item.id)}
          onKeyDown={(keyEvent) => {
            const delta = keyEvent.key === "ArrowRight" ? 1 : keyEvent.key === "ArrowLeft" ? -1 : 0;
            if (!delta) return;
            keyEvent.preventDefault();
            const next = items[(index + delta + items.length) % items.length];
            if (!next) return;
            onSelect(next.id);
            refs.current[next.id]?.focus();
          }}
        >
          {item.label}
          {item.count === undefined ? null : <span className="count">{item.count}</span>}
        </button>
      ))}
    </div>
  );
}

export type HubTabItem = { id: string; label: string; href: string; count?: number };

/** Stable sibling jobs rendered as links because every selection must remain shareable. */
export function HubTabs({
  items,
  active,
  label,
}: {
  items: readonly HubTabItem[];
  active: string;
  label: string;
}) {
  const linkProps = useLinkProps();
  const activeRef = useRef<HTMLAnchorElement>(null);

  // A settings hub can have more tabs than a phone can show. Direct navigation used to leave
  // Reports and Activity off-screen with no visible indication of which page was open. Keep the
  // selected destination in view without moving the whole page vertically.
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });

  return (
    <nav className="hub-tabs" aria-label={label}>
      {items.map((item) => (
        <a
          key={item.id}
          ref={item.id === active ? activeRef : undefined}
          className="hub-tab"
          aria-current={item.id === active ? "page" : undefined}
          {...linkProps(item.href)}
        >
          <span>{item.label}</span>
          {item.count === undefined ? null : <span className="count">{item.count}</span>}
        </a>
      ))}
    </nav>
  );
}

export function Toolbar({
  children,
  label,
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & { label?: string }) {
  const classes = ["toolbar", className].filter(Boolean).join(" ");
  if (label)
    return (
      <div {...props} className={classes} role="toolbar" aria-label={label}>
        {children}
      </div>
    );
  return (
    <div {...props} className={classes}>
      {children}
    </div>
  );
}

/** The container a `GutterRow` belongs in: rows with no gap, so the spine stays continuous. */
export function GutterList({
  children,
  label,
  className,
}: {
  children: ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <ul className={className ? `gutter-list ${className}` : "gutter-list"} aria-label={label}>
      {children}
    </ul>
  );
}

/**
 * The product's signature row: one measure in the left gutter, everything else to the right of
 * the spine.
 *
 * `measure` is required and has no default. The gutter appears only where a row genuinely has
 * a figure — a time, a count, a duration, an index, a state glyph — because a gutter drawn down
 * rows that carry no measure is the ornament it was brought in to replace. A settings form has
 * no gutter, and the type system is where that restraint is cheapest to enforce.
 */
export function GutterRow({
  measure,
  measureLabel,
  title,
  meta,
  status,
  actions,
  children,
  active,
}: {
  /** The single figure this row is about. Set it in `.figure` type; see `.gutter` in shell.css. */
  measure: ReactNode;
  /**
   * What the figure means, for a reader who cannot see the column heading. It is announced as a
   * **prefix**: "Attempts" before "3", the way a column heading precedes its cell. Write the noun
   * alone and never fold the value into it.
   *
   * It used to replace the figure rather than precede it — the visible measure took
   * `aria-hidden` whenever a label was passed — so five rows announced "Attempts", "Views so
   * far" and "Version" to a screen reader and never once said the number, which is the only
   * thing the row is about.
   */
  measureLabel?: string;
  title: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  active?: boolean;
}) {
  return (
    <li className="gutter-row" aria-current={active ? "true" : undefined}>
      <span className="gutter">
        <span className="figure">
          {measureLabel ? <span className="visually-hidden">{measureLabel} </span> : null}
          <span>{measure}</span>
        </span>
      </span>
      <div className="gutter-content">
        <div className="gutter-title">{title}</div>
        {meta ? <div className="gutter-meta">{meta}</div> : null}
        {children ? <div className="gutter-detail">{children}</div> : null}
      </div>
      {status ? <div className="gutter-status">{status}</div> : null}
      {actions ? <div className="gutter-actions">{actions}</div> : null}
    </li>
  );
}

/**
 * Platform-dialog drawer. The browser owns modality and focus containment; this component owns
 * labelling, close affordances, Escape policy, and returning the close request to its caller.
 */
export function Drawer({
  open,
  title,
  description,
  children,
  footer,
  busy = false,
  onClose,
}: {
  open: boolean;
  title: string;
  /** Plain supporting copy; block content belongs in the drawer body. */
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  /*
   * A caller that unmounts the drawer while `open` is still true — `{x ? <Drawer …/> : null}`
   * rather than `open={x}` — detaches a dialog the platform still holds as modal, so the inert
   * backdrop and the top-layer entry outlive the element and the focus the browser would have
   * returned to the trigger is dropped on `<body>` instead. Two agenda call sites shipped exactly
   * that. Closing here is the safety net under the mistake rather than a substitute for `open`:
   * only a mounted dialog can hand focus back to what opened it.
   *
   * It is its own mount-only effect, and it closes only a dialog React has already detached.
   * Written as the cleanup of the `[open]` effect above, it ran on every re-run of that effect —
   * and a re-run is not an unmount. `main.tsx` renders the console inside `StrictMode`, which
   * tears an effect down and sets it up again on mount, so a drawer whose caller mounts it
   * already open was closed between the two: the platform's `close` event fired while `open` was
   * still true, and `onClose` below reported to the caller that the reader had dismissed a drawer
   * they had only just opened. `isConnected` separates the two teardowns — a simulated one leaves
   * the element in the document, a real deletion does not.
   */
  useEffect(() => {
    // The element is captured while the effect runs rather than read from the ref inside the
    // cleanup: React nulls a ref during the commit that deletes the component, so by teardown
    // `dialogRef.current` is null and there is nothing left to close.
    const dialog = dialogRef.current;
    return () => {
      if (dialog?.open && !dialog.isConnected) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="drawer"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy || undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClose={() => {
        if (open && !busy) onClose();
      }}
    >
      <header className="drawer-header">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description ? <p id={descriptionId}>{description}</p> : null}
        </div>
        <button
          type="button"
          className="secondary drawer-close"
          onClick={onClose}
          disabled={busy}
          aria-label={`Close ${title}`}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="drawer-body">{children}</div>
      {footer ? <footer className="drawer-footer">{footer}</footer> : null}
    </dialog>
  );
}

/**
 * One shimmering bar. Private: a lone bar is a decision every caller got to make differently,
 * which is how thirty surfaces ended up rendering the bare string "Loading…" instead. The
 * composed shapes below are the API.
 */
function Bar({ width = "100%", height = "1rem" }: { width?: string | number; height?: string }) {
  return <span className="skeleton" style={{ width, height }} aria-hidden="true" />;
}

/**
 * Placeholder for a list or table that is still loading. One live region announces the wait;
 * the bars themselves are decoration and stay out of the accessibility tree.
 */
export function SkeletonRows({ rows = 3, label = "Loading" }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton-rows" role="status" aria-label={label}>
      <Rows rows={rows} />
    </div>
  );
}

/**
 * The bars a row placeholder is made of, without the live region that announces them.
 *
 * Exported for the second placeholder on a page that is already announcing one wait: the rule
 * one screen down is one live region for the page, not one per part, and a surface with two
 * skeletons up at once — a board and the stage panel open over it — says the same wait twice.
 */
export function SkeletonBars({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-rows">
      <Rows rows={rows} />
    </div>
  );
}

function Rows({ rows }: { rows: number }) {
  return Array.from({ length: rows }, (_, row) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: placeholder bars have no identity.
    <span className="skeleton-row" key={row}>
      <Bar width={`${68 - (row % 3) * 12}%`} />
      <Bar width="18%" height="0.75rem" />
    </span>
  ));
}

/** Placeholder for a row of metric figures. */
export function SkeletonStats({
  tiles = 4,
  label = "Loading",
}: {
  tiles?: number;
  label?: string;
}) {
  return (
    <div className="skeleton-stats grid-auto" role="status" aria-label={label}>
      {Array.from({ length: tiles }, (_, tile) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder bars have no identity.
        <span className="skeleton-stat" key={tile}>
          <Bar width="46%" height="0.75rem" />
          <Bar width="30%" height="1.75rem" />
        </span>
      ))}
    </div>
  );
}

/** Placeholder for a form: a label bar and a control bar per field. */
export function SkeletonForm({
  fields = 3,
  label = "Loading",
}: {
  fields?: number;
  label?: string;
}) {
  return (
    <div className="skeleton-form" role="status" aria-label={label}>
      {Array.from({ length: fields }, (_, field) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder bars have no identity.
        <span className="skeleton-field" key={field}>
          <Bar width="32%" height="0.8125rem" />
          <Bar height="var(--control-h)" />
        </span>
      ))}
    </div>
  );
}

/**
 * Placeholder for a whole page: title, then rows. The first paint of a route.
 *
 * One live region for the page, not one per part — nesting `SkeletonRows` here would announce the
 * same wait twice, which is exactly the conditional-live-region noise the shell exists to avoid.
 */
export function SkeletonPage({ label = "Loading" }: { label?: string }) {
  return (
    <div className="skeleton-page" role="status" aria-label={label}>
      <Bar width="34%" height="1.75rem" />
      <Bar width="52%" height="0.8125rem" />
      <div className="skeleton-rows">
        <Rows rows={4} />
      </div>
    </div>
  );
}

/**
 * Nothing here yet — and what to do about it.
 *
 * The icon is required. It used to default to an inbox, which meant one glyph stood in for
 * every empty area in the product: no speakers, no schedule, no matches, no permission. An
 * empty screen is an invitation to act, so it names what is missing and offers the action.
 *
 * `terse` is the other half of that: a state with no body copy and no action is not an invitation
 * at all, it is a confirmation that there is nothing to do — and given the full centred treatment
 * it became a tall near-empty region with one reassuring line floating in the middle of it. It is
 * claimed automatically when there is nothing but a title, and can be asked for by a caller whose
 * sentence is the only body it needs.
 */
export function EmptyState({
  title,
  icon,
  children,
  action,
  terse,
}: {
  title: string;
  icon: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  /** Defaults to true when the state carries neither body copy nor an action. */
  terse?: boolean;
}) {
  const compact = terse ?? (!children && !action);
  return (
    <div className={compact ? "empty is-terse" : "empty"}>
      <span className="glyph">{icon}</span>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/**
 * Not empty — refused. The reader is looking at a surface their account cannot open, and the
 * only useful thing to tell them is which permission is missing and who can grant it. An
 * empty-state inbox glyph told them the opposite: that there was nothing here.
 */
export function Refusal({
  title = "You do not have access",
  capability,
  grantedBy,
  children,
  action,
  level = 3,
}: {
  title?: string;
  /** What the account is missing, named the way the product names it. */
  capability: ReactNode;
  /** Who can grant it — a role, not a person. */
  grantedBy: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  /**
   * The title's heading level. `3` by default, because a refusal normally sits in a card under
   * the page's own `<h1>`. A refusal that *is* the page passes `1`: the console's public landing
   * is one card and nothing else, so at the default it published a document whose highest
   * heading was an `<h3>` — the only branch of the shell with no `<h1>` at all. A `PageHeader`
   * above it is not the fix, because it would print the same sentence twice.
   */
  level?: 1 | 3;
}) {
  const Heading = level === 1 ? "h1" : "h3";
  return (
    <div className="empty is-refusal">
      <span className="glyph">
        <IconShield size={20} />
      </span>
      <Heading>{title}</Heading>
      {children ? <p>{children}</p> : null}
      <p className="refusal-grant">
        Needs {capability}. {grantedBy} can grant it.
      </p>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/**
 * What happened, and what happens next. A finished action leaves the reader somewhere; this is
 * that somewhere, so it always carries the follow-on rather than ending the flow with a full
 * stop. Failures interrupt, successes stay polite.
 */
export function Outcome({
  tone,
  title,
  children,
  action,
}: {
  tone: "success" | "failure";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={tone === "success" ? "empty is-success" : "empty is-failure"}
      role={tone === "success" ? "status" : "alert"}
    >
      <span className="glyph">
        {tone === "success" ? <IconCheck size={20} /> : <IconWarning size={20} />}
      </span>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "ok" | "warn" | "danger" | "info" | "strong";
  children: ReactNode;
}) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Stat({
  label,
  value,
  hint,
  icon,
  attention,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  attention?: boolean;
}) {
  return (
    <div className={attention ? "stat is-attention" : "stat"}>
      <dt>
        {label}
        {icon}
      </dt>
      <dd>{value}</dd>
      {hint ? <dd className="delta">{hint}</dd> : null}
    </div>
  );
}

/*
 * The tone glyph, from the shared set at its own size.
 *
 * `info` used to be a hand-drawn circle on a 24-unit grid at 1.7 stroke, rendered at 16 — the
 * one glyph in the product not drawn like the rest, sitting next to two that were. `IconInfo`
 * exists now, and at the set's 20-unit grid every stroke lands on a whole device pixel.
 */
function NoticeGlyph({ tone }: { tone: "info" | "error" | "warn" | "success" }) {
  if (tone === "success") return <IconCheck />;
  if (tone === "info") return <IconInfo />;
  return <IconWarning />;
}

/**
 * The correlation reference a refusal came back with, on its own line.
 *
 * Twenty-five helpers used to glue it onto the end of the message — "…could not be saved.
 * Reference: 01JD…". A reader asked to quote an identifier cannot select one that shares a
 * paragraph with prose, and the identifier is the only part of the sentence read character by
 * character, so it sets as a measure and takes a copy button of its own.
 *
 * The clipboard can refuse — an insecure origin, a denied permission — and a copy button that
 * silently does nothing is worse than no button. The reference is already on screen and
 * selectable, so the refusal is answered by saying so rather than by a second control.
 */
function NoticeReference({ reference }: { reference: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "manual">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      setStatus("manual");
      return;
    }
    try {
      await clipboard.writeText(reference);
      setStatus("copied");
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setStatus("idle"), 6000);
    } catch {
      // ERROR-INTENT: a refused clipboard is a permission answer, not a fault. It is reported
      // to the reader as the manual path below rather than logged and swallowed.
      setStatus("manual");
    }
  }

  return (
    <p className="notice-reference">
      <span className="visually-hidden">Reference</span>
      <code className="figure">{reference}</code>
      <button
        type="button"
        className="ghost small"
        // ERROR-INTENT: `copy` settles every outcome into the status below — copied, or the
        // manual path — so it has no rejection left for a handler to receive.
        onClick={() => void copy()}
        aria-label="Copy the reference"
      >
        {status === "copied" ? "Copied" : "Copy"}
      </button>
      {/*
        One region, always mounted, whose text changes — swapping a live region in when the
        first message arrives is the pattern assistive technology commonly misses.
      */}
      <span
        className={status === "idle" ? "visually-hidden" : "notice-reference-note"}
        role="status"
      >
        {status === "copied"
          ? "Reference copied."
          : status === "manual"
            ? "This browser refused the clipboard. Select the reference and copy it."
            : ""}
      </span>
    </p>
  );
}

/**
 * A standing message about the surface it sits on — not the transient confirmation of an action,
 * which is `useActionFeedback`.
 *
 * A warning interrupts as well as an error: the audit found "this event is not published yet"
 * and "these times are in the venue's zone" rendered politely to nobody. `info` carries the
 * information pair rather than the plain surface it used to borrow.
 */
export function Notice({
  tone = "info",
  title,
  children,
  reference,
  action,
  onDismiss,
  dismissLabel = "Dismiss",
  role,
}: {
  tone?: "info" | "error" | "warn" | "success";
  title?: ReactNode;
  children: ReactNode;
  /**
   * The correlation reference the server answered with, from `describeApiFailure`. Pass it
   * here rather than gluing it onto the sentence — see `NoticeReference`.
   */
  reference?: string | null | undefined;
  action?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  role?: "alert" | "status";
}) {
  return (
    <div
      className={`notice ${tone}`}
      role={role ?? (tone === "error" || tone === "warn" ? "alert" : undefined)}
    >
      <span className="notice-glyph" aria-hidden="true">
        <NoticeGlyph tone={tone} />
      </span>
      <div className="notice-body">
        {title ? <p className="notice-title">{title}</p> : null}
        <div className="notice-text">{children}</div>
        {reference ? <NoticeReference reference={reference} /> : null}
        {action ? <div className="notice-actions">{action}</div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          className="ghost small notice-dismiss"
          aria-label={dismissLabel}
          onClick={onDismiss}
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  );
}

/**
 * A read that did not come back, and the one control that can change that.
 *
 * Pair it with `useLoad`: `<LoadFailure what="the agenda" error={error} onRetry={reload} />`.
 * Roughly thirty surfaces used to render the bare string "Loading…" and, on failure, nothing
 * a reader could act on.
 */
export function LoadFailure({
  what,
  error,
  reference,
  onRetry,
  retryLabel = "Try again",
  children,
}: {
  /** What failed to load, as the reader would name it: "the agenda", "your queue". */
  what: string;
  error?: string | null;
  /** The correlation reference, from `describeApiFailure`. Never glued onto `error`. */
  reference?: string | null;
  onRetry?: () => unknown;
  retryLabel?: string;
  children?: ReactNode;
}) {
  return (
    <Notice
      tone="error"
      title={`${what.charAt(0).toUpperCase()}${what.slice(1)} could not be loaded`}
      reference={reference}
      action={
        onRetry ? (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              // ERROR-INTENT: the retry's rejection is already stored in the caller's load state,
              // which is what renders this component; rethrowing here would only be unhandled.
              void Promise.resolve(onRetry()).catch(() => undefined);
            }}
          >
            {retryLabel}
          </button>
        ) : null
      }
    >
      {children ?? error ?? "The request did not come back. Nothing on this page has changed."}
    </Notice>
  );
}

/**
 * Announces the outcome of an async action to screen readers and keeps it on screen
 * near the control that triggered it. The audit found confirmations rendering 749px
 * below the button that caused them, and nothing announced at all.
 *
 * `announce` takes either a sentence or the whole `ApiFailure` that `describeApiFailure` returns,
 * so the correlation reference reaches the same monospace, copyable line `Notice` and
 * `LoadFailure` give it. Until it did, a surface reporting failures here had two choices — drop
 * the reference the server answered with, or glue it onto the sentence — and the console did
 * both, so the same identifier arrived as a selectable value on one page and as the tail of a
 * paragraph on the next.
 */
export function useActionFeedback() {
  const [message, setMessage] = useState<{
    tone: "success" | "error";
    text: string;
    reference: string | null;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function announce(tone: "success" | "error", detail: string | ApiFailure) {
    clearTimeout(timer.current);
    setMessage(
      typeof detail === "string"
        ? { tone, text: detail, reference: null }
        : { tone, text: detail.message, reference: detail.reference },
    );
    if (tone === "success") timer.current = setTimeout(() => setMessage(null), 6000);
  }

  /*
   * One element, always mounted, whose text changes. Swapping the region in when the first
   * message arrives is the conditional-live-region pattern that assistive technology commonly
   * misses, so the paragraph exists from first render and only its role and text change.
   *
   * The reference sits beside the region rather than inside it, in the same box, the same way
   * `Notice` places it. It is a value to quote, not news: announcing a 26-character ULID
   * character by character ahead of the sentence explaining what happened helps nobody.
   */
  const node = (
    <div
      className={
        message ? (message.tone === "error" ? "notice error" : "notice success") : "visually-hidden"
      }
    >
      <div className="notice-body">
        {/* Failures take role="alert" so they interrupt, successes stay polite. */}
        <p role={message?.tone === "error" ? "alert" : "status"}>{message?.text ?? ""}</p>
        {message?.reference ? <NoticeReference reference={message.reference} /> : null}
      </div>
    </div>
  );

  return { announce, node, clear: () => setMessage(null) };
}

type LoadState<Key, Value> = {
  key: Key;
  data: Value | null;
  error: string | null;
  /** The correlation reference of `error`, for `LoadFailure`'s own `reference` prop. */
  reference: string | null;
  /** Why the most recent refresh over data already on screen failed, if it did. */
  refreshError: ApiFailure | null;
  loading: boolean;
};

/** A refusal is either a bare sentence or the whole `ApiFailure` `describeApiFailure` returns. */
const failureOf = (described: string | ApiFailure): ApiFailure =>
  typeof described === "string" ? { message: described, reference: null } : described;

/**
 * Owns one keyed read lifecycle. Changing the key clears the previous entity immediately,
 * and a monotonically increasing sequence prevents an older response from painting over a
 * newer request. Imperative reloads retain current data so forms do not unmount mid-edit.
 *
 * `describeError` may answer with an `ApiFailure` instead of a sentence, which is how the
 * correlation reference reaches `LoadFailure` as its own selectable value rather than as a
 * clause a caller glued onto the end of the message.
 *
 * A first read that fails owns the surface through `error`; a refresh that fails answers in
 * `refreshError` instead, because replacing a working page — and any form open on it — with a
 * full-page failure is exactly what "reloads retain current data" promises not to do. The two
 * are separate fields rather than one because they are separate states, and collapsing them is
 * what made a failed refresh indistinguishable from a successful one: the rejection went
 * nowhere, so a surface whose only control is "try again" answered the press with a
 * byte-identical page. Callers that `await reload()` still get the rejection thrown at them.
 */
export function useLoad<Key, Value>(
  key: Key,
  loader: (key: Key) => Promise<Value>,
  describeError: (reason: unknown) => string | ApiFailure,
) {
  const sequence = useRef(0);
  const mounted = useRef(true);
  const [state, setState] = useState<LoadState<Key, Value>>({
    key,
    data: null,
    error: null,
    reference: null,
    refreshError: null,
    loading: true,
  });

  const run = useCallback(
    async (clear = false) => {
      const request = ++sequence.current;
      setState((current) => ({
        key,
        data: clear ? null : current.data,
        error: null,
        reference: null,
        refreshError: null,
        loading: true,
      }));
      try {
        const data = await loader(key);
        if (mounted.current && sequence.current === request)
          setState({
            key,
            data,
            error: null,
            reference: null,
            refreshError: null,
            loading: false,
          });
        return data;
      } catch (reason) {
        if (mounted.current && sequence.current === request)
          setState((current) => {
            // Whether this read owns the surface: with nothing on screen there is nothing to
            // keep, so the failure is the page. Otherwise the page stays and the failure is
            // news beside it — kept, not dropped, so the reader learns the data is stale.
            const owns = clear || current.data === null;
            const failure = failureOf(describeError(reason));
            return {
              key,
              data: clear ? null : current.data,
              error: owns ? failure.message : null,
              reference: owns ? failure.reference : null,
              refreshError: owns ? null : failure,
              loading: false,
            };
          });
        throw reason;
      }
    },
    [describeError, key, loader],
  );

  useEffect(() => {
    mounted.current = true;
    // ERROR-INTENT: useLoad stores the rejection in its returned error state.
    void run(true).catch(() => undefined);
    return () => {
      mounted.current = false;
      sequence.current += 1;
    };
  }, [run]);

  const currentState = Object.is(state.key, key)
    ? state
    : { key, data: null, error: null, reference: null, refreshError: null, loading: true };

  return {
    ...currentState,
    // A refresh over data already on screen is a different state from a first paint: the page
    // stays, and the region says it is busy. Without this every surface had to derive it, so
    // none of them did — a reload silently replaced the page or silently did nothing.
    isRefreshing: currentState.loading && currentState.data !== null,
    reload: () => run(false),
  };
}
