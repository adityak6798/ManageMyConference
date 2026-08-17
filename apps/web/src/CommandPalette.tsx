/**
 * The console's command palette: one keystroke to any record — or any surface — on the event.
 *
 * Two ways in, always. `Cmd/Ctrl+K` is what an operator who already knows the tool will use,
 * and a visible control in the topbar is what makes it exist for everybody else — a shortcut
 * with no affordance is a feature only the person who wrote it can find, and it is invisible to
 * an automated accessibility sweep as well.
 *
 * It answers two different questions with one list. **Take me somewhere** is served locally from
 * the hub-tab registry, filtered by what this account can open: roughly twenty hub-tab
 * destinations had no keyboard route at all, because the palette only ever searched records.
 * **Find this thing** is the server's answer, and every hit carries the console path the server
 * produced for it — the browser never derives a route from a label or a kind, because which
 * surface a record opens depends on the role that read it, and a reviewer sent to the
 * organizer's abstracts board would land on a refusal.
 *
 * @spec PRD-OPS-001 PRD-IAM-002
 */
import {
  SEARCH_QUERY_MIN_LENGTH,
  type SearchResponseDto,
  type SearchResultDto,
  type SearchSectionKey,
} from "@greenroom/contracts";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { type ApiFailure, describeApiFailure } from "./api/config";
import { searchEvent } from "./api/platform";
import { useFocusTrap } from "./platform/focus-trap";
import { navigate } from "./router";
import {
  IconCalendar,
  IconChevronRight,
  IconClose,
  IconPipeline,
  IconReview,
  IconSearch,
  IconSend,
  IconSessions,
  IconSpeakers,
  IconTask,
} from "./ui/icons";
import { HUB_PATHS, type WorkspaceAccess, type WorkspaceHub } from "./workspaces/contract";
import { canOpenTab, hubTabsFor } from "./workspaces/registry";

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

/** A glyph in place of a word: the kind is a category, and a category reads faster as a mark. */
const KIND_GLYPHS: Readonly<Record<SearchResultDto["kind"], ReactNode>> = {
  session: <IconSessions size={16} />,
  speaker: <IconSpeakers size={16} />,
  proposal: <IconReview size={16} />,
  task: <IconTask size={16} />,
  "agenda-item": <IconCalendar size={16} />,
  delivery: <IconSend size={16} />,
  contact: <IconPipeline size={16} />,
};

const HUB_LABELS: Readonly<Record<WorkspaceHub, string>> = {
  program: "Program",
  people: "People",
  schedule: "Schedule",
  communications: "Communications",
  publish: "Publish",
  settings: "Settings",
};

const HUB_ORDER = Object.keys(HUB_LABELS) as WorkspaceHub[];

/** One selectable row, whether it came from the registry or from the server. */
type Entry = {
  id: string;
  title: string;
  subtitle?: string | undefined;
  href: string;
  /** What the row is, for a reader who cannot see the glyph. */
  kindLabel: string;
  glyph: ReactNode;
};

type Group = { key: string; label: string; entries: Entry[] };

interface PaletteState {
  /** The last answer that arrived, kept while the next one is in flight. */
  answer: SearchResponseDto | null;
  loading: boolean;
  failure: ApiFailure | null;
}

const IDLE: PaletteState = { answer: null, loading: false, failure: null };

function sectionsWhere(answer: SearchResponseDto | null, state: "unauthorized" | "failed") {
  if (!answer) return [];
  return SECTION_ORDER.filter((key) => answer.sections[key].state === state);
}

export function CommandPalette({
  eventId,
  access,
  open,
  onClose,
}: {
  eventId: string;
  /**
   * What this account can open. The destination list is filtered by it rather than merely
   * ordered by it: offering a keyboard route to a surface that answers with a refusal is worse
   * than not offering it, because the reader has to learn the refusal one destination at a time.
   */
  access: WorkspaceAccess;
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

  const trimmed = query.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < SEARCH_QUERY_MIN_LENGTH;
  const searchable = trimmed.length >= SEARCH_QUERY_MIN_LENGTH;

  /** Every hub tab this account can open, as a destination. Computed here, asked of nobody. */
  const destinations = useMemo<Entry[]>(() => {
    const persona = access.activeRole === "custom" ? "organizer" : access.activeRole;
    return HUB_ORDER.flatMap((hub) =>
      hubTabsFor(hub, persona)
        .filter((tab) => canOpenTab(tab, access))
        .map((tab) => ({
          id: `${hub}:${tab.tab}`,
          title: `${HUB_LABELS[hub]} · ${tab.label}`,
          href: `${HUB_PATHS[hub]}?tab=${encodeURIComponent(tab.tab)}&event=${encodeURIComponent(eventId)}`,
          kindLabel: "Destination",
          glyph: <IconChevronRight size={16} />,
        })),
    );
  }, [access, eventId]);

  const groups = useMemo<Group[]>(() => {
    const needle = trimmed.toLowerCase();
    const matching = needle
      ? destinations.filter((entry) => entry.title.toLowerCase().includes(needle))
      : destinations;
    const result: Group[] = [];
    if (matching.length > 0) result.push({ key: "go-to", label: "Go to", entries: matching });
    // Rendered by mapping the declared order rather than by flattening first: a section with
    // results is a heading over those results, and a section with none renders nothing at all.
    for (const key of SECTION_ORDER) {
      const section = state.answer?.sections[key];
      if (section?.state !== "ok" || section.results.length === 0) continue;
      result.push({
        key,
        label: SECTION_LABELS[key],
        entries: section.results.map((hit) => ({
          id: `${hit.kind}:${hit.id}`,
          title: hit.title,
          subtitle: hit.subtitle,
          href: hit.href,
          kindLabel: KIND_LABELS[hit.kind],
          glyph: KIND_GLYPHS[hit.kind],
        })),
      });
    }
    // The full-page search surface is no longer a sidebar item, so this is how a reader reaches
    // it: as the last thing the palette offers, once there is a query to carry over.
    if (searchable)
      result.push({
        key: "all",
        label: "Everything else",
        entries: [
          {
            id: "see-all",
            title: `See all results for “${trimmed}”`,
            href: `/search?event=${encodeURIComponent(eventId)}`,
            kindLabel: "Search",
            glyph: <IconSearch size={16} />,
          },
        ],
      });
    return result;
  }, [destinations, eventId, searchable, state.answer, trimmed]);

  const entries = useMemo(() => groups.flatMap((group) => group.entries), [groups]);
  const unauthorized = useMemo(() => sectionsWhere(state.answer, "unauthorized"), [state.answer]);
  const failed = useMemo(() => sectionsWhere(state.answer, "failed"), [state.answer]);
  const matchCount = useMemo(
    () =>
      SECTION_ORDER.reduce((total, key) => {
        const section = state.answer?.sections[key];
        return section?.state === "ok" ? total + section.results.length : total;
      }, 0),
    [state.answer],
  );

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

  // The page behind the overlay is still operable without this: a dialog the reader can Tab out
  // of leaves them driving a page that is visually covered.
  useFocusTrap(dialogRef, open);

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
    if (!searchable) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    const generation = ++issued.current;
    const timer = setTimeout(() => {
      setState((current) => ({ ...current, loading: true, failure: null }));
      // ERROR-INTENT: effects cannot await; both outcomes are rendered by the state below.
      void searchEvent(eventId, trimmed, { signal: controller.signal })
        .then((answer) => {
          if (generation !== issued.current) return;
          setState({ answer, loading: false, failure: null });
          setActiveIndex(0);
        })
        .catch((reason: unknown) => {
          // ERROR-INTENT: an aborted request is the next keystroke's doing rather than a
          // failure, and a superseded answer has nothing left to report to.
          if (controller.signal.aborted || generation !== issued.current) return;
          setState({
            answer: null,
            loading: false,
            failure: describeApiFailure(reason, "Search is unavailable right now."),
          });
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, searchable, trimmed, eventId]);

  // A filter that shortens the list must not leave the pointer past the end of it.
  useEffect(() => {
    setActiveIndex((current) => (current < entries.length ? current : 0));
  }, [entries.length]);

  const openEntry = useCallback(
    (entry: Entry) => {
      navigate(entry.href);
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
    if (entries.length === 0) return;
    if (keyEvent.key === "ArrowDown") {
      keyEvent.preventDefault();
      setActiveIndex((current) => (current + 1) % entries.length);
      return;
    }
    if (keyEvent.key === "ArrowUp") {
      keyEvent.preventDefault();
      setActiveIndex((current) => (current - 1 + entries.length) % entries.length);
      return;
    }
    if (keyEvent.key === "Enter") {
      const entry = entries[activeIndex];
      if (!entry) return;
      keyEvent.preventDefault();
      openEntry(entry);
    }
  }

  if (!open) return null;

  const announcement = state.failure
    ? state.failure.message
    : tooShort
      ? `Type at least ${SEARCH_QUERY_MIN_LENGTH} characters to search.`
      : state.loading
        ? "Searching…"
        : state.answer
          ? matchCount === 0
            ? `No matches for “${state.answer.query}”.`
            : `${matchCount} ${matchCount === 1 ? "match" : "matches"} for “${state.answer.query}”.`
          : destinations.length > 0
            ? `Type to search this event, or open one of ${destinations.length} destinations.`
            : "Type to search this event.";

  let index = -1;

  return (
    /*
     * The backdrop dims and blocks, and does nothing else. Click-outside-to-dismiss is a
     * pointer-only affordance on an element with no role and no name, so it would have to be
     * excused from two accessibility rules to buy a third way to do what Escape and the Close
     * control already do — for the one input device that already has both of them.
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
          <IconSearch className="palette-field-glyph" />
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
            placeholder="Search this event, or jump to a section…"
            value={query}
            aria-expanded={entries.length > 0}
            aria-controls={listId}
            {...(entries.length > 0 ? { "aria-activedescendant": optionId(activeIndex) } : {})}
            onChange={(changeEvent) => setQuery(changeEvent.target.value)}
          />
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
          The results are the only scrolling part of the dialog. The whole panel used to scroll,
          which pushed the input and the dismiss control off the top the moment a search returned
          more than a screenful — the one control the reader needed to correct the query.

          A `div` rather than a `ul`, and options that hold no control of their own.
          `role="option"` allows no interactive descendant, so a button inside each row would be
          both an ARIA violation and a second tab stop inside a widget whose whole point is to
          have one. Keyboard operation therefore lives on the combobox above: Arrow moves
          `aria-activedescendant`, Enter opens whatever it points at.
        */}
        <div className="palette-results" id={listId} role="listbox" aria-label="Search results">
          {groups.map((group) => (
            // `group` is the one role a listbox may hold besides `option`, which is what lets
            // the headings exist at all — a bare heading element inside a listbox is an
            // unnamed child of a list that claims to hold only choices.
            // biome-ignore lint/a11y/useSemanticElements: a <fieldset> is not a legal child of a listbox; `group` is the only role ARIA allows here beside `option`.
            <div className="palette-group" key={group.key} role="group" aria-label={group.label}>
              <p className="palette-group-label" aria-hidden="true">
                {group.label}
              </p>
              {group.entries.map((entry) => {
                index += 1;
                const position = index;
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox above owns Arrow and Enter for every option.
                  <div
                    key={`${group.key}:${entry.id}`}
                    id={optionId(position)}
                    role="option"
                    tabIndex={-1}
                    aria-selected={position === activeIndex}
                    className={
                      position === activeIndex ? "palette-result is-active" : "palette-result"
                    }
                    onClick={() => openEntry(entry)}
                    onMouseEnter={() => setActiveIndex(position)}
                  >
                    <span className="palette-glyph" aria-hidden="true">
                      {entry.glyph}
                    </span>
                    <span className="visually-hidden">{entry.kindLabel}</span>
                    <span className="palette-title">{entry.title}</span>
                    {entry.subtitle ? (
                      <span className="palette-subtitle">{entry.subtitle}</span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/*
          The live region above is the only place each state is *stated*; the notes below only
          add what it does not say. Rendering both would put the same sentence on screen twice
          and, for the failure, announce it twice as well.
        */}
        {!state.failure && !state.loading && state.answer && matchCount === 0 ? (
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

        {state.failure?.reference ? (
          <p className="palette-note is-error">Reference: {state.failure.reference}</p>
        ) : null}

        {/*
          The keys are the surface. Naming them where the reader already is beats a Close button
          that taught nothing and, once the list scrolled, was no longer on screen anyway.
        */}
        <div className="palette-footer">
          <p className="palette-keys figure">↑↓ navigate · ↵ open · esc close</p>
          <button type="button" className="ghost small palette-dismiss" onClick={close}>
            <IconClose size={16} />
            <span className="visually-hidden">Close search</span>
          </button>
        </div>
      </div>
    </div>
  );
}
