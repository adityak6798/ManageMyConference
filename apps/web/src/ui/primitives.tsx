/*
 * Shared page furniture.
 *
 * Every workspace is assembled from these so a new surface never invents its own
 * chrome, and so fixes to focus handling, empty states, or announcement behaviour
 * land everywhere at once.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
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
      {hint ? <p className="delta">{hint}</p> : null}
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
