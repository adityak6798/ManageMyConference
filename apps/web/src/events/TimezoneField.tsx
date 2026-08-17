/*
 * The event timezone control.
 *
 * A free-text box here was a data-integrity defect rather than a cosmetic one: the value drives
 * the times an attendee reads on the public site, the hours the agenda board draws, and the
 * `DTSTART` of every `.ics` invite a speaker accepts. A typo produced wrong times everywhere
 * with no error anywhere (#206).
 *
 * The list comes from the browser's own zone database through `Intl.supportedValuesOf`, so it
 * cannot go stale against a bundled copy and costs no bytes. Where that is unavailable the
 * field falls back to `FALLBACK_ZONES` below — a shorter list, never a different control.
 *
 * It is a filtering `Combobox` rather than a `<select>`, because roughly 400 options is the
 * one list length a native select is worst at: the popup is a single unsearchable column, and
 * the only way to reach `Europe/Madrid` is to know it sorts after `Europe/Madeira`. Typing
 * "mad" now narrows the list to what matches, in the same control, and the zones are no longer
 * grouped by area — an area heading was structure standing in for a search box.
 *
 * The API is deliberately more permissive than this list. `resolveTimezone` in the contracts
 * package accepts anything the runtime can resolve, including fixed offsets such as `+05:30`,
 * and refuses only what resolves to no zone at all. The console offers named zones because that
 * is what an organizer should pick; a caller that needs an offset uses the API. A stored value
 * this list does not contain — an offset, or a zone from a newer database — is kept as its own
 * option, so opening the form never silently rewrites the event's zone to whatever sorts first.
 */
import { useMemo } from "react";
import { Combobox, type SelectOption } from "../ui/fields";

/**
 * Enough to keep the field useful on an engine with no zone enumeration.
 *
 * Every entry is the id the zone database canonicalizes to, so that picking one stores exactly
 * what was picked. `Asia/Calcutta` rather than `Asia/Kolkata` for that reason alone — the newer
 * spelling resolves to the older id, so offering it would have shown one name and stored another.
 */
const FALLBACK_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Athens",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Calcutta",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
] as const;

type ZoneEnumeration = { supportedValuesOf?: (key: string) => string[] };

/** Every zone this engine knows, canonical ids only, with `UTC` — which the list omits. */
export function supportedTimezones(): string[] {
  const enumeration = Intl as unknown as ZoneEnumeration;
  let zones: string[];
  try {
    zones = enumeration.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    // ERROR-INTENT: an engine may declare the method and refuse the key; the fallback list is
    // the recovery and the field stays usable either way.
    zones = [];
  }
  if (zones.length === 0) return [...FALLBACK_ZONES];
  return zones.includes("UTC") ? zones : ["UTC", ...zones];
}

/** `America/Los_Angeles` → `UTC−07:00`, read from the zone rather than from a table. */
function offsetLabel(zone: string, at: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "longOffset",
    }).formatToParts(at);
    const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    // `longOffset` renders UTC itself as plain "GMT"; every other zone as "GMT+05:30".
    return name === "GMT" ? "UTC±00:00" : name.replace("GMT", "UTC").replace("-", "−");
  } catch {
    // ERROR-INTENT: a zone the list offered but this formatter cannot render still has to be
    // selectable; it is named without an offset rather than dropped from the list.
    return "";
  }
}

export function TimezoneField({
  id,
  value,
  onChange,
  errors = [],
  disabled = false,
  label = "Event timezone",
  hint = "Drives the times shown on the public site, the agenda board, and every calendar invite.",
}: {
  id: string;
  value: string;
  onChange: (timezone: string) => void;
  errors?: readonly string[];
  disabled?: boolean;
  label?: string;
  hint?: string;
}) {
  const now = useMemo(() => new Date(), []);
  const options = useMemo<SelectOption[]>(() => {
    const zones = supportedTimezones();
    // An event stored before this control existed may hold a legacy alias — `US/Pacific`,
    // `Asia/Calcutta` — that the canonical list does not carry. Dropping it would silently
    // reselect the first option and rewrite the event's timezone on the next save.
    const all = zones.includes(value) || !value ? zones : [value, ...zones];
    // The offset is the measure that separates two zones with similar names, so it is the
    // option's second line rather than part of its label: filtering on "+05:30" finds every
    // zone at that offset, and the label stays the id that gets stored.
    return all.map((zone) => ({ value: zone, label: zone, hint: offsetLabel(zone, now) }));
  }, [now, value]);

  return (
    <Combobox
      id={id}
      label={label}
      hint={hint}
      value={value}
      onChange={onChange}
      options={options}
      error={errors}
      disabled={disabled}
      required
      placeholder="Search zones, cities or offsets…"
      emptyLabel="No zone matches that. Try a city, a region, or an offset such as +05:30."
    />
  );
}
