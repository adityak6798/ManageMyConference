/*
 * Where a chosen row's detail lands, on both CRM surfaces.
 *
 * Choosing a row used to set state and nothing else. The detail is the second column of a
 * non-sticky `align-items: start` split, so opening the thirtieth prospect in a list scrolled
 * nothing, moved no focus, and produced no visible change whatsoever — the panel it filled was
 * already a screen and a half above the pointer. The directory had the same defect for the same
 * reason.
 *
 * Two answers, and they are one answer at two widths. Above the width `.split` collapses at, the
 * panel is a sticky column with its own scroll and it takes focus when it opens, so selection
 * *becomes* focus rather than merely being recorded. At or below that width there is no second
 * column to be sticky in, so the detail is the shared Drawer, which moves focus by being a modal
 * dialog and returns it on close.
 *
 * Kept here rather than in `ui/` because it is the CRM's own composition of two shared
 * primitives, not a new primitive.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Card, Drawer } from "../ui/primitives";

/**
 * Whether the page is at or below the width where `.split` becomes one column (shell.css).
 *
 * The guard is the shell's: jsdom does not implement `matchMedia`, and a workspace that threw in
 * unit tests to decide where its detail panel goes would be trading one defect for a worse one.
 */
export function useCollapsedSplit(): boolean {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia("(max-width: 960px)");
    const update = () => setCollapsed(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return collapsed;
}

export function Inspector({
  open,
  focusKey,
  title,
  hint,
  labelledBy,
  closeLabel,
  onClose,
  children,
}: {
  open: boolean;
  /** The identity of what is open. A different row re-takes focus; the same row does not. */
  focusKey: string;
  title: string;
  hint?: string;
  labelledBy: string;
  /** Names the close control for the reader who cannot see which panel it belongs to. */
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const collapsed = useCollapsedSplit();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (collapsed || !open || !focusKey) return;
    panel.current?.focus();
  }, [collapsed, open, focusKey]);

  if (collapsed)
    return (
      <Drawer open={open} title={title} {...(hint ? { description: hint } : {})} onClose={onClose}>
        {open ? children : null}
      </Drawer>
    );

  return (
    /* `tabIndex={-1}` is the target of a programmatic move, not a tab stop: opening a row has to
       land the reader on what it opened, and nothing else may reach this container by Tab. */
    <div className="crm-inspector" ref={panel} tabIndex={-1}>
      <Card
        labelledBy={labelledBy}
        title={title}
        {...(hint ? { hint } : {})}
        actions={
          open ? (
            <button type="button" className="ghost" onClick={onClose}>
              {closeLabel}
            </button>
          ) : null
        }
      >
        {children}
      </Card>
    </div>
  );
}
