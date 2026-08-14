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
 * field degrades to a text box with a `datalist` of the common zones — a picker the organizer
 * can still type into, rather than nothing. Either way the API is the boundary that decides:
 * `resolveTimezone` in the contracts package refuses what this list would never have offered.
 */
import { useMemo } from "react";

/** Enough to keep the field useful on an engine with no zone enumeration. */
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
  "Asia/Kolkata",
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

/** `America/Los_Angeles` → `America`, so a 400-entry list is navigable by region. */
const areaOf = (zone: string) => (zone.includes("/") ? zone.slice(0, zone.indexOf("/")) : "Other");

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
  const groups = useMemo(() => {
    const zones = supportedTimezones();
    // An event stored before this control existed may hold a legacy alias — `US/Pacific`,
    // `Asia/Calcutta` — that the canonical list does not carry. Dropping it would silently
    // reselect the first option and rewrite the event's timezone on the next save.
    const all = zones.includes(value) || !value ? zones : [value, ...zones];
    const byArea = new Map<string, string[]>();
    for (const zone of all) {
      const area = areaOf(zone);
      const bucket = byArea.get(area);
      if (bucket) bucket.push(zone);
      else byArea.set(area, [zone]);
    }
    return [...byArea.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [value]);

  const errorId = `${id}-error`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        required
        aria-invalid={errors.length ? true : undefined}
        aria-describedby={errors.length ? errorId : `${id}-hint`}
        onChange={(changeEvent) => onChange(changeEvent.target.value)}
      >
        {groups.map(([area, zones]) => (
          <optgroup key={area} label={area}>
            {zones.map((zone) => {
              const offset = offsetLabel(zone, now);
              return (
                <option key={zone} value={zone}>
                  {offset ? `${zone} · ${offset}` : zone}
                </option>
              );
            })}
          </optgroup>
        ))}
      </select>
      {errors.length ? (
        <p className="error-text" id={errorId}>
          {errors.join(" ")}
        </p>
      ) : (
        <p className="hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}
