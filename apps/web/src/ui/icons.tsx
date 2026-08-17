/*
 * Inline icon set.
 *
 * Icons are inlined rather than pulled from a package: the whole set is a few kilobytes,
 * it keeps the bundle dependency-free, and it works with no network — all three matter for
 * a demo that is judged partly on speed.
 *
 * Every glyph is drawn on a 20-unit grid at 1.5 stroke and defaults to `size = 20`, which
 * is the fix for a set that used to be authored on a 24 grid and rendered at 16: every
 * stroke resolved to 1.13 device pixels, so the whole sidebar looked faintly out of focus
 * next to text that was hinted. On the 20 grid at 20px the geometry lands on the pixel
 * grid, and at any other size it scales from an even ratio.
 *
 * The set is deliberately large enough that no glyph stands for two different things. One
 * gear used to mean Members, Webhooks, API clients and Settings, and one inbox meant the
 * platform inbox, event templates and every empty area in the product — which is what made
 * the navigation read as placeholder art. Every navigation destination now has its own
 * glyph; see docs/product/design-language.md for the destination-to-glyph assignment.
 *
 * Every icon is decorative. Callers that need a name expose it in adjacent text or an
 * aria-label on the interactive parent, so the SVGs stay aria-hidden.
 */

type IconProps = { size?: number; className?: string };

function svg(path: React.ReactNode, { size = 20, className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {path}
    </svg>
  );
}

/* ---- destinations ------------------------------------------------------- */

export const IconDashboard = (p: IconProps) =>
  svg(
    <>
      <rect x="2.5" y="2.5" width="6" height="7" rx="1.25" />
      <rect x="11.5" y="2.5" width="6" height="4" rx="1.25" />
      <rect x="11.5" y="8.5" width="6" height="9" rx="1.25" />
      <rect x="2.5" y="11.5" width="6" height="6" rx="1.25" />
    </>,
    p,
  );

/** A form: the call for proposals is a page of questions before it is anything else. */
export const IconForm = (p: IconProps) =>
  svg(
    <>
      <rect x="3.5" y="2.5" width="13" height="15" rx="2" />
      <path d="M6.75 6.75h6.5M6.75 10h6.5M6.75 13.25h4" />
    </>,
    p,
  );

/** A read submission: the same page as IconForm, judged. */
export const IconReview = (p: IconProps) =>
  svg(
    <>
      <path d="M11 2.5H5.5A1.5 1.5 0 0 0 4 4v12a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 16 16V7.5z" />
      <path d="M11 2.5V7.5h5" />
      <path d="m7.25 12 1.75 1.75L12.75 10" />
    </>,
    p,
  );

export const IconCalendar = (p: IconProps) =>
  svg(
    <>
      <rect x="2.5" y="4" width="15" height="13.5" rx="2" />
      <path d="M2.5 8.25h15M6.75 2.5v3.25M13.25 2.5v3.25" />
    </>,
    p,
  );

/** A lit stage with a lectern: the room a session happens in. */
export const IconSessions = (p: IconProps) =>
  svg(
    <>
      <rect x="2.5" y="3.5" width="15" height="11" rx="2" />
      <path d="M7 17.5h6M10 14.5v3" />
    </>,
    p,
  );

/** Two people: the speaker directory, and every list of contacts. */
export const IconSpeakers = (p: IconProps) =>
  svg(
    <>
      <circle cx="7.75" cy="6.75" r="2.75" />
      <path d="M2.75 16.75a5 5 0 0 1 10 0" />
      <path d="M13.25 4.5a2.75 2.75 0 0 1 0 4.5M17.25 16.75a5.1 5.1 0 0 0-2.5-3.75" />
    </>,
    p,
  );

/** A person and a plus: Members is the surface where somebody is invited in. */
export const IconMembers = (p: IconProps) =>
  svg(
    <>
      <circle cx="8" cy="6.75" r="3" />
      <path d="M2.5 16.75a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.5v4.5M18.25 7.75h-4.5" />
    </>,
    p,
  );

/** Three columns of unequal height: a pipeline is a board where the stages differ. */
export const IconPipeline = (p: IconProps) =>
  svg(
    <>
      <rect x="2.5" y="4" width="4" height="8" rx="1.25" />
      <rect x="8" y="4" width="4" height="12" rx="1.25" />
      <rect x="13.5" y="4" width="4" height="5.5" rx="1.25" />
    </>,
    p,
  );

export const IconSend = (p: IconProps) =>
  svg(
    <>
      <path d="M17.5 2.5 8.75 11.25" />
      <path d="M17.5 2.5 11.9 17.5 8.8 11.2 2.5 8.1z" />
    </>,
    p,
  );

export const IconGlobe = (p: IconProps) =>
  svg(
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M2.5 10h15M10 2.5c2 2.2 3 4.7 3 7.5s-1 5.3-3 7.5c-2-2.2-3-4.7-3-7.5s1-5.3 3-7.5z" />
    </>,
    p,
  );

/** Waves leaving a point: publishing is the schedule going out to the house. */
export const IconBroadcast = (p: IconProps) =>
  svg(
    <>
      <circle cx="10" cy="10" r="1.75" />
      <path d="M6.5 13.5a5 5 0 0 1 0-7M13.5 6.5a5 5 0 0 1 0 7" />
      <path d="M3.9 16.1a9 9 0 0 1 0-12.2M16.1 3.9a9 9 0 0 1 0 12.2" />
    </>,
    p,
  );

/** A checklist with two ticked lines: what somebody still owes the programme. */
export const IconTask = (p: IconProps) =>
  svg(
    <>
      <path d="m2.75 6 1.25 1.25L6.5 4.75" />
      <path d="m2.75 13.25 1.25 1.25 2.5-2.5" />
      <path d="M9.5 6h7.75M9.5 13.5h7.75" />
    </>,
    p,
  );

/** A sheet of bars: a report is a question asked of a dataset. */
export const IconReport = (p: IconProps) =>
  svg(
    <>
      <rect x="3.5" y="2.5" width="13" height="15" rx="2" />
      <path d="M7 14v-3.5M10 14V6.5M13 14v-5.5" />
    </>,
    p,
  );

export const IconSettings = (p: IconProps) =>
  svg(
    <>
      <circle cx="10" cy="10" r="2.5" />
      <path d="M10 2.25v1.9M10 15.85v1.9M17.75 10h-1.9M4.15 10h-1.9M15.48 4.52l-1.34 1.34M5.86 14.14l-1.34 1.34M15.48 15.48l-1.34-1.34M5.86 5.86 4.52 4.52" />
    </>,
    p,
  );

/** Sliders: how a surface is set up, as opposed to what it is allowed to do. */
export const IconSliders = (p: IconProps) =>
  svg(
    <>
      <path d="M3 6.5h3.25M11.25 6.5h5.75" />
      <circle cx="8.75" cy="6.5" r="2.25" />
      <path d="M3 13.5h5.75M13.75 13.5h3.25" />
      <circle cx="11.25" cy="13.5" r="2.25" />
    </>,
    p,
  );

/** A shield, for the surface that decides what a role may see. */
export const IconShield = (p: IconProps) =>
  svg(
    <>
      <path d="M10 2.5 4 5.15v4.9c0 3.6 2.4 6.3 6 7.45 3.6-1.15 6-3.85 6-7.45v-4.9z" />
      <path d="m7.5 9.9 1.75 1.75L13 8" />
    </>,
    p,
  );

/** A key: an API client is a credential before it is anything else. */
export const IconKey = (p: IconProps) =>
  svg(
    <>
      <circle cx="6.75" cy="13.25" r="3.25" />
      <path d="m9.05 10.95 7.45-7.45" />
      <path d="m13 7 2 2M15 5l2 2" />
    </>,
    p,
  );

/** A plug and its lead: a webhook is Greenroom wired into somebody else's system. */
export const IconWebhook = (p: IconProps) =>
  svg(
    <>
      <path d="M6.75 2.5v4M13.25 2.5v4" />
      <rect x="3.5" y="6.5" width="13" height="4" rx="1.5" />
      <path d="M10 10.5v3.25a3.25 3.25 0 0 1-3.25 3.25H5" />
    </>,
    p,
  );

export const IconInbox = (p: IconProps) =>
  svg(
    <>
      <path d="M2.5 11.5 4.7 4.6a1.6 1.6 0 0 1 1.55-1.1h7.5a1.6 1.6 0 0 1 1.55 1.1l2.2 6.9V15a1.6 1.6 0 0 1-1.6 1.6H4.1A1.6 1.6 0 0 1 2.5 15z" />
      <path d="M2.5 11.5h4l1 1.9h5l1-1.9h4" />
    </>,
    p,
  );

export const IconClock = (p: IconProps) =>
  svg(
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 5.5v4.9l2.9 1.7" />
    </>,
    p,
  );

export const IconSearch = (p: IconProps) =>
  svg(
    <>
      <circle cx="9" cy="9" r="5.5" />
      <path d="m13.2 13.2 4.3 4.3" />
    </>,
    p,
  );

/* ---- state and feedback ------------------------------------------------- */

export const IconCheck = (p: IconProps) =>
  svg(
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="m6.6 10.2 2.3 2.3 4.5-4.7" />
    </>,
    p,
  );

export const IconWarning = (p: IconProps) =>
  svg(
    <>
      <path d="M8.6 3.4 2.45 14.6A1.6 1.6 0 0 0 3.85 17h12.3a1.6 1.6 0 0 0 1.4-2.4L11.4 3.4a1.6 1.6 0 0 0-2.8 0z" />
      <path d="M10 7.5v3.75M10 14.15h.01" />
    </>,
    p,
  );

export const IconInfo = (p: IconProps) =>
  svg(
    <>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 9.25v4.5M10 6.5h.01" />
    </>,
    p,
  );

/** An open crate: nothing has been put here yet. */
export const IconEmpty = (p: IconProps) =>
  svg(
    <>
      <path d="M10 2.75 16.75 6.5v7L10 17.25 3.25 13.5v-7z" />
      <path d="m3.25 6.5 6.75 3.75 6.75-3.75M10 10.25v7" />
    </>,
    p,
  );

export const IconStar = (p: IconProps) =>
  svg(
    <path d="m10 2.75 2.3 4.65 5.2.75-3.75 3.65.9 5.15L10 14.5l-4.65 2.45.9-5.15L2.5 8.15l5.2-.75z" />,
    p,
  );

/* ---- actions ------------------------------------------------------------ */

export const IconPlus = (p: IconProps) => svg(<path d="M10 3.75v12.5M3.75 10h12.5" />, p);

export const IconClose = (p: IconProps) => svg(<path d="m5 5 10 10M15 5 5 15" />, p);

export const IconMenu = (p: IconProps) => svg(<path d="M3 5.75h14M3 10h14M3 14.25h14" />, p);

export const IconChevronDown = (p: IconProps) => svg(<path d="m5 7.75 5 5 5-5" />, p);

export const IconChevronRight = (p: IconProps) => svg(<path d="m7.75 5 5 5-5 5" />, p);

export const IconExternal = (p: IconProps) =>
  svg(
    <>
      <path d="M11.5 3h5.5v5.5M17 3l-7 7" />
      <path d="M14.5 12v3.5A1.5 1.5 0 0 1 13 17H4.5A1.5 1.5 0 0 1 3 15.5V7a1.5 1.5 0 0 1 1.5-1.5H8" />
    </>,
    p,
  );

export const IconFilter = (p: IconProps) => svg(<path d="M3 5h14M6 10h8M8.5 15h3" />, p);

export const IconTrash = (p: IconProps) =>
  svg(
    <>
      <path d="M3.5 5.5h13" />
      <path d="M7.75 5.5V4a1 1 0 0 1 1-1h2.5a1 1 0 0 1 1 1v1.5" />
      <path d="M5.25 5.5 6 16.1a1.5 1.5 0 0 0 1.5 1.4h5a1.5 1.5 0 0 0 1.5-1.4l.75-10.6" />
      <path d="M8.5 8.75v5.25M11.5 8.75v5.25" />
    </>,
    p,
  );

export const IconEdit = (p: IconProps) =>
  svg(
    <>
      <path d="M12.9 3.85a1.6 1.6 0 0 1 2.25 0l1 1a1.6 1.6 0 0 1 0 2.25L7.4 16.1l-3.9.4.4-3.9z" />
      <path d="m11.75 5 3.25 3.25" />
    </>,
    p,
  );

export const IconCopy = (p: IconProps) =>
  svg(
    <>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M13 4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13" />
    </>,
    p,
  );

export const IconMail = (p: IconProps) =>
  svg(
    <>
      <rect x="2.5" y="4.25" width="15" height="11.5" rx="1.75" />
      <path d="m2.75 6 6.35 4.4a1.6 1.6 0 0 0 1.8 0L17.25 6" />
    </>,
    p,
  );

export const IconLink = (p: IconProps) =>
  svg(
    <>
      <path d="M8.75 11.25a3.4 3.4 0 0 0 4.8 0l2.35-2.35a3.4 3.4 0 1 0-4.8-4.8L9.9 5.25" />
      <path d="M11.25 8.75a3.4 3.4 0 0 0-4.8 0L4.1 11.1a3.4 3.4 0 0 0 4.8 4.8l1.2-1.2" />
    </>,
    p,
  );

/** Six dots: the grip a row's action menu hangs off. */
export const IconGrip = (p: IconProps) =>
  svg(
    <>
      <circle cx="7.5" cy="5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="10" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="10" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="7.5" cy="15" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="15" r="1.1" fill="currentColor" stroke="none" />
    </>,
    p,
  );

/** Three dots: more actions than the row has room for. */
export const IconMore = (p: IconProps) =>
  svg(
    <>
      <circle cx="4.75" cy="10" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="10" cy="10" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="15.25" cy="10" r="1.15" fill="currentColor" stroke="none" />
    </>,
    p,
  );
