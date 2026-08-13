/**
 * The console's command palette: one keystroke to any record on the event.
 *
 * Two ways in, always. `Cmd/Ctrl+K` is what an operator who already knows the tool will use,
 * and a visible control in the topbar is what makes it exist for everybody else — a shortcut
 * with no affordance is a feature only the person who wrote it can find, and it is invisible to
 * an automated accessibility sweep as well.
 *
 * Every hit carries the console path the server produced for it. The browser never derives a
 * route from a label or a kind, because which surface a record opens depends on the role that
 * read it, and a reviewer sent to the organizer's abstracts board would land on a refusal.
 *
 * @spec PRD-OPS-001 PRD-IAM-002
 */
import {
  SEARCH_QUERY_MIN_LENGTH,
  type SearchResponseDto,
  type SearchResultDto,
  type SearchSectionKey,
} from "@greenroom/contracts";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ResponseContractError } from "./api/config";
import { PlatformApiError, searchEvent } from "./api/platform";
import { navigate } from "./router";

/** Long enough that a typed word is one request, short enough to feel immediate. */
const DEBOUNCE_MS = 180;

const SECTION_LABELS: Readonly<Record<SearchSectionKey, string>> = {
  content: "Sessions, speakers and tasks",
  review: "Proposals",
  agenda: "Agenda",
  communications: "Deliveries",
  crm: "Contacts",
};

const SECTION_ORDER: readonly SearchSectionKey[] = [
  "content",
  "review",
  "agenda",
  "communications",
  "crm",
];

const KIND_LABELS: Readonly<Record<SearchResultDto["kind"], string>> = {
  session: "Session",
  speaker: "Speaker",
  proposal: "Proposal",
  task: "Task",
  "agenda-item": "Agenda",
  delivery: "Delivery",
  contact: "Contact",
};

interface PaletteState {
  /** The last answer that arrived, kept while the next one is in flight. */
  answer: SearchResponseDto | null;
  loading: boolean;
  error: string | null;
}

const IDLE: PaletteState = { answer: null, loading: false, error: null };

function describeFailure(reason: unknown): string {
  if (reason instanceof PlatformApiError)
    return `${reason.envelope.error.message} Reference: ${reason.envelope.error.correlationId}`;
  if (reason instanceof ResponseContractError) return reason.message;
  return "Search is unavailable right now. Close this and try again.";
}

/** Everything currently selectable, in the order it is rendered. */
function flatten(answer: SearchResponseDto | null): SearchResultDto[] {
  if (!answer) return [];
  return SECTION_ORDER.flatMap((key) => {
    const section = answer.sections[key];
    return section.state === "ok" ? [...section.results] : [];
  });
}

function sectionsWhere(answer: SearchResponseDto | null, state: "unauthorized" | "failed") {
  if (!answer) return [];
  return SECTION_ORDER.filter((key) => answer.sections[key].state === state);
}

export function CommandPalette({
  eventId,
  open,
  onClose,
}: {
  eventId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [state, setState] = useState<PaletteState>(IDLE);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  /** Whatever had focus when the palette opened, so closing puts it back. */
  const opener = useRef<HTMLElement | null>(null);
  /**
   * Answers are numbered and anything behind the newest applied answer is dropped.
   *
   * The `AbortController` below stops the *request*; this stops a response that was already on
   * the wire when the newer keystroke was typed from painting over it. Both are needed — the
   * repository's existing reads use the counter, and aborting alone cannot order two answers
   * that are already in flight.
   */
  const issued = useRef(0);
  const baseId = useId();
  const listId = `${baseId}-results`;
  const titleId = `${baseId}-title`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const results = useMemo(() => flatten(state.answer), [state.answer]);
  const unauthorized = useMemo(() => sectionsWhere(state.answer, "unauthorized"), [state.answer]);
  const failed = useMemo(() => sectionsWhere(state.answer, "failed"), [state.answer]);
  const trimmed = query.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < SEARCH_QUERY_MIN_LENGTH;

  // Opening is the only moment that can decide where focus came from, so it is recorded here
  // rather than by whichever control happened to invoke it.
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setState(IDLE);
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [open]);

  const close = useCallback(() => {
    const returnTo = opener.current;
    onClose();
    // Focus follows the control the operator actually used. Falling back to the main landmark
    // rather than to <body> keeps a keyboard user inside the page they were reading.
    if (returnTo?.isConnected) returnTo.focus();
    else document.getElementById("main")?.focus({ preventScroll: true });
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    if (trimmed.length < SEARCH_QUERY_MIN_LENGTH) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    const generation = ++issued.current;
    const timer = setTimeout(() => {
      setState((current) => ({ ...current, loading: true, error: null }));
      // ERROR-INTENT: effects cannot await; both outcomes are rendered by the state below.
      void searchEvent(eventId, trimmed, { signal: controller.signal })
        .then((answer) => {
          if (generation !== issued.current) return;
          setState({ answer, loading: false, error: null });
          setActiveIndex(0);
        })
        .catch((reason: unknown) => {
          // ERROR-INTENT: an aborted request is the next keystroke's doing rather than a
          // failure, and a superseded answer has nothing left to report to.
          if (controller.signal.aborted || generation !== issued.current) return;
          setState({ answer: null, loading: false, error: describeFailure(reason) });
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, trimmed, eventId]);

  const openResult = useCallback(
    (result: SearchResultDto) => {
      navigate(result.href);
      onClose();
      // The destination replaces the whole surface, exactly as a persona switch does, so focus
      // moves to the new content instead of staying on a control that no longer exists.
      requestAnimationFrame(() => {
        const main = document.getElementById("main");
        main?.setAttribute("tabindex", "-1");
        main?.focus({ preventScroll: true });
      });
    },
    [onClose],
  );

  function onKeyDown(keyEvent: React.KeyboardEvent<HTMLDivElement>) {
    if (keyEvent.key === "Escape") {
      keyEvent.preventDefault();
      close();
      return;
    }
    if (keyEvent.key === "Tab") {
      // Trapped by wrapping within the dialog's own focusable controls: a dialog the user can
      // Tab out of leaves them operating a page that is visually behind an overlay.
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'input, button, [href], [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (keyEvent.shiftKey && document.activeElement === first) {
        keyEvent.preventDefault();
        last.focus();
      } else if (!keyEvent.shiftKey && document.activeElement === last) {
        keyEvent.preventDefault();
        first.focus();
      }
      return;
    }
    if (results.length === 0) return;
    if (keyEvent.key === "ArrowDown") {
      keyEvent.preventDefault();
      setActiveIndex((current) => (current + 1) % results.length);
      return;
    }
    if (keyEvent.key === "ArrowUp") {
      keyEvent.preventDefault();
      setActiveIndex((current) => (current - 1 + results.length) % results.length);
      return;
    }
    if (keyEvent.key === "Enter") {
      const result = results[activeIndex];
      if (!result) return;
      keyEvent.preventDefault();
      openResult(result);
    }
  }

  if (!open) return null;

  const announcement = state.error
    ? state.error
    : tooShort
      ? `Type at least ${SEARCH_QUERY_MIN_LENGTH} characters to search.`
      : state.loading
        ? "Searching…"
        : state.answer
          ? results.length === 0
            ? `No matches for “${state.answer.query}”.`
            : `${results.length} ${results.length === 1 ? "match" : "matches"} for “${state.answer.query}”.`
          : "Type to search this event.";

  return (
    /*
     * The backdrop dims and blocks, and does nothing else. Click-outside-to-dismiss is a
     * pointer-only affordance on an element with no role and no name, so it would have to be
     * excused from two accessibility rules to buy a third way to do what Escape and the Close
     * button already do — for the one input device that already has both of them.
     */
    <div className="palette-backdrop">
      <div
        className="palette"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <h2 className="visually-hidden" id={titleId}>
          Search this event
        </h2>
        <div className="palette-field">
          <label className="visually-hidden" htmlFor={`${baseId}-input`}>
            Search sessions, speakers, proposals, agenda, deliveries and contacts
          </label>
          <input
            id={`${baseId}-input`}
            ref={inputRef}
            className="palette-input"
            type="text"
            role="combobox"
            autoComplete="off"
            placeholder="Search this event…"
            value={query}
            aria-expanded={results.length > 0}
            aria-controls={listId}
            {...(results.length > 0 ? { "aria-activedescendant": optionId(activeIndex) } : {})}
            onChange={(changeEvent) => setQuery(changeEvent.target.value)}
          />
          <button type="button" className="secondary" onClick={close}>
            Close
          </button>
        </div>

        {/*
          `aria-live` without `role="status"` on purpose: a workspace behind this overlay may
          already own the page's one status region, and a second one is the trap `ACC-AGENDA`
          records — two polite regions racing to describe two different things.
        */}
        <p className="palette-announce" aria-live="polite">
          {announcement}
        </p>

        {/*
          A `div` rather than a `ul`, and options that hold no control of their own.
          `role="option"` allows no interactive descendant, so a button inside each row would be
          both an ARIA violation and a second tab stop inside a widget whose whole point is to
          have one. Keyboard operation therefore lives on the combobox above: Arrow moves
          `aria-activedescendant`, Enter opens whatever it points at.
        */}
        <div className="palette-results" id={listId} role="listbox" aria-label="Search results">
          {results.map((result, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox above owns Arrow and Enter for every option.
            <div
              key={`${result.kind}:${result.id}`}
              id={optionId(index)}
              role="option"
              tabIndex={-1}
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "palette-result is-active" : "palette-result"}
              onClick={() => openResult(result)}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <span className="palette-kind">{KIND_LABELS[result.kind]}</span>
              <span className="palette-title">{result.title}</span>
              {result.subtitle ? <span className="palette-subtitle">{result.subtitle}</span> : null}
            </div>
          ))}
        </div>

        {/*
          The live region above is the only place each state is *stated*; the notes below only
          add what it does not say. Rendering both would put the same sentence on screen twice
          and, for the failure, announce it twice as well.
        */}
        {!state.error && !state.loading && state.answer && results.length === 0 ? (
          <p className="palette-note">Try a session title, a speaker, a room, or an address.</p>
        ) : null}

        {unauthorized.length > 0 ? (
          <p className="palette-note">
            Not available to your role on this event:{" "}
            {unauthorized.map((key) => SECTION_LABELS[key]).join(", ")}.
          </p>
        ) : null}

        {failed.length > 0 ? (
          <p className="palette-note is-error">
            These could not be searched just now:{" "}
            {failed.map((key) => SECTION_LABELS[key]).join(", ")}. Everything else above is
            complete.
          </p>
        ) : null}
      </div>
    </div>
  );
}
