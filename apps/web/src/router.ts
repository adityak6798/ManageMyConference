/*
 * Minimal History-API router.
 *
 * The product needs shareable, reloadable URLs for every workspace surface — an
 * evaluator following the runbook should be able to link straight to the agenda or
 * a reviewer queue. A router library would be ~10kB for the three things we use, and
 * the competition rewards a small, fast bundle, so this stays hand-rolled.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";

type Listener = () => void;

const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readPath() {
  return window.location.pathname + window.location.search;
}

let patched = false;
function patchHistory() {
  if (patched) return;
  patched = true;
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method].bind(history);
    history[method] = ((...args: Parameters<History["pushState"]>) => {
      original(...args);
      emit();
    }) as History[typeof method];
  }
  window.addEventListener("popstate", emit);
}

/** Navigate without a full page load. `replace` avoids stacking history entries. */
export function navigate(to: string, options: { replace?: boolean } = {}) {
  patchHistory();
  if (readPath() === to) return;
  if (options.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  // Land at the top of the new surface the way a real page load would.
  window.scrollTo({ top: 0 });
}

/** Current `pathname + search`, re-rendering on any history change. */
export function useLocation(): string {
  useEffect(patchHistory, []);
  return useSyncExternalStore(subscribe, readPath, () => "/");
}

/**
 * Props for an anchor that navigates client-side but stays a real link — middle
 * click, cmd-click, and "open in new tab" must keep working.
 */
export function useLinkProps() {
  return useCallback(
    (to: string) => ({
      href: to,
      onClick(clickEvent: React.MouseEvent<HTMLAnchorElement>) {
        if (
          clickEvent.defaultPrevented ||
          clickEvent.button !== 0 ||
          clickEvent.metaKey ||
          clickEvent.ctrlKey ||
          clickEvent.shiftKey ||
          clickEvent.altKey
        )
          return;
        clickEvent.preventDefault();
        navigate(to);
      },
    }),
    [],
  );
}

/**
 * Match `pattern` (with `:param` segments) against a concrete path.
 * Returns the captured params, or null when the pattern does not apply.
 */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = (path.split("?")[0] ?? "").split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (const [index, part] of patternParts.entries()) {
    const value = pathParts[index] ?? "";
    if (part.startsWith(":")) {
      params[part.slice(1)] = decodeURIComponent(value);
      continue;
    }
    if (part !== value) return null;
  }
  return params;
}
