/*
 * Shared page furniture.
 *
 * Every workspace is assembled from these so a new surface never invents its own
 * chrome, and so fixes to focus handling, empty states, or announcement behaviour
 * land everywhere at once.
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
import { useLinkProps } from "../router";
import { IconInbox } from "./icons";

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

/** Two-column operational layout with a readable stacked fallback on narrow screens. */
export function ListDetail({
  list,
  detail,
  listLabel,
  detailLabel,
}: {
  list: ReactNode;
  detail: ReactNode;
  listLabel: string;
  detailLabel: string;
}) {
  return (
    <div className="list-detail">
      <section className="list-detail-list" aria-label={listLabel}>
        {list}
      </section>
      <aside className="list-detail-panel" aria-label={detailLabel}>
        {detail}
      </aside>
    </div>
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
          className="secondary small drawer-close"
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

export function DataList({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul className="data-list" aria-label={label}>
      {children}
    </ul>
  );
}

export function DataListRow({
  title,
  metadata,
  status,
  actions,
  children,
}: {
  title: ReactNode;
  metadata?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="data-list-row">
      <div className="data-list-primary">
        <div className="data-list-title">{title}</div>
        {metadata ? <div className="data-list-metadata">{metadata}</div> : null}
        {children ? <div className="data-list-content">{children}</div> : null}
      </div>
      {status ? <div className="data-list-status">{status}</div> : null}
      {actions ? <div className="data-list-actions">{actions}</div> : null}
    </li>
  );
}

export function Skeleton({
  width = "100%",
  height = "1rem",
  label = "Loading",
}: {
  width?: string | number;
  height?: string | number;
  label?: string;
}) {
  return (
    <span className="skeleton" style={{ width, height }} role="status" aria-label={label}>
      <span className="visually-hidden" aria-hidden="true">
        {label}
      </span>
    </span>
  );
}

export function EmptyState({
  title,
  children,
  icon,
  action,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="glyph">{icon ?? <IconInbox size={20} />}</span>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
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

export function Notice({
  tone = "info",
  children,
  role,
}: {
  tone?: "info" | "error" | "warn" | "success";
  children: ReactNode;
  role?: "alert" | "status";
}) {
  const className = tone === "info" ? "notice" : `notice ${tone}`;
  return (
    <p className={className} role={role ?? (tone === "error" ? "alert" : undefined)}>
      {children}
    </p>
  );
}

/**
 * Announces the outcome of an async action to screen readers and keeps it on screen
 * near the control that triggered it. The audit found confirmations rendering 749px
 * below the button that caused them, and nothing announced at all.
 */
export function useActionFeedback() {
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function announce(tone: "success" | "error", text: string) {
    clearTimeout(timer.current);
    setMessage({ tone, text });
    if (tone === "success") timer.current = setTimeout(() => setMessage(null), 6000);
  }

  // One element, always mounted, whose text changes. Swapping the element in when the
  // first message arrives is the conditional-live-region pattern that assistive
  // technology commonly misses, so the region exists from first render and only its
  // content and styling change.
  const node = (
    <p
      className={
        message ? (message.tone === "error" ? "notice error" : "notice success") : "visually-hidden"
      }
      // The element is never remounted; only its role, class, and text change. Failures
      // take role="alert" so they interrupt, successes stay polite.
      role={message?.tone === "error" ? "alert" : "status"}
    >
      {message?.text ?? ""}
    </p>
  );

  return { announce, node, clear: () => setMessage(null) };
}

type LoadState<Key, Value> = {
  key: Key;
  data: Value | null;
  error: string | null;
  loading: boolean;
};

/**
 * Owns one keyed read lifecycle. Changing the key clears the previous entity immediately,
 * and a monotonically increasing sequence prevents an older response from painting over a
 * newer request. Imperative reloads retain current data so forms do not unmount mid-edit.
 */
export function useLoad<Key, Value>(
  key: Key,
  loader: (key: Key) => Promise<Value>,
  describeError: (reason: unknown) => string,
) {
  const sequence = useRef(0);
  const mounted = useRef(true);
  const [state, setState] = useState<LoadState<Key, Value>>({
    key,
    data: null,
    error: null,
    loading: true,
  });

  const run = useCallback(
    async (clear = false) => {
      const request = ++sequence.current;
      setState((current) => ({
        key,
        data: clear ? null : current.data,
        error: null,
        loading: true,
      }));
      try {
        const data = await loader(key);
        if (mounted.current && sequence.current === request)
          setState({ key, data, error: null, loading: false });
        return data;
      } catch (reason) {
        if (mounted.current && sequence.current === request)
          setState((current) => ({
            key,
            data: clear ? null : current.data,
            error: clear || current.data === null ? describeError(reason) : null,
            loading: false,
          }));
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
    : { key, data: null, error: null, loading: true };

  return { ...currentState, reload: () => run(false) };
}
