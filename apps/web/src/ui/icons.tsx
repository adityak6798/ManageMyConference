/*
 * Inline icon set.
 *
 * Icons are inlined rather than pulled from a package: the whole set is under 3kB,
 * it keeps the bundle dependency-free, and it works with no network — all three
 * matter for a demo that is judged partly on speed.
 *
 * Every icon is decorative. Callers that need a name expose it in adjacent text or
 * an aria-label on the interactive parent, so the SVGs stay aria-hidden.
 */

type IconProps = { size?: number; className?: string };

function svg(path: React.ReactNode, { size = 16, className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {path}
    </svg>
  );
}

export const IconDashboard = (p: IconProps) =>
  svg(
    <>
      <rect x="3" y="3" width="7" height="8" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="11" width="7" height="10" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </>,
    p,
  );

export const IconForm = (p: IconProps) =>
  svg(
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h4" />
    </>,
    p,
  );

export const IconReview = (p: IconProps) =>
  svg(
    <>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H18a2 2 0 0 1 2 2v12.5" />
      <path d="M6 20h12.5a1.5 1.5 0 0 0 0-3H6a2 2 0 0 0-2 2v-13" />
      <path d="M9 9h7" />
    </>,
    p,
  );

export const IconCalendar = (p: IconProps) =>
  svg(
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>,
    p,
  );

export const IconSpeakers = (p: IconProps) =>
  svg(
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.5a3.2 3.2 0 0 1 0 6M17.5 20a5.6 5.6 0 0 0-2-4.3" />
    </>,
    p,
  );

export const IconSend = (p: IconProps) =>
  svg(
    <>
      <path d="M21 3 10.5 13.5" />
      <path d="M21 3l-6.8 18-3.7-7.5L3 9.8z" />
    </>,
    p,
  );

export const IconGlobe = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.4 2.6 3.6 5.6 3.6 9S14.4 18.4 12 21c-2.4-2.6-3.6-5.6-3.6-9S9.6 5.6 12 3z" />
    </>,
    p,
  );

export const IconSessions = (p: IconProps) =>
  svg(
    <>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M8 21h8M12 18v3" />
    </>,
    p,
  );

export const IconTask = (p: IconProps) =>
  svg(
    <>
      <path d="M4.5 7.5 6 9l2.5-2.5" />
      <path d="M4.5 16.5 6 18l2.5-2.5" />
      <path d="M12 8h8M12 17h8" />
    </>,
    p,
  );

export const IconSettings = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3" />
    </>,
    p,
  );

export const IconWarning = (p: IconProps) =>
  svg(
    <>
      <path d="M10.3 3.9 2.5 17.4A2 2 0 0 0 4.2 20.4h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4.5M12 17h.01" />
    </>,
    p,
  );

export const IconCheck = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.3 2.7 2.7L16 9.5" />
    </>,
    p,
  );

export const IconClock = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.3l3.2 1.9" />
    </>,
    p,
  );

export const IconInbox = (p: IconProps) =>
  svg(
    <>
      <path d="M3 13.5 5.6 5.2A2 2 0 0 1 7.5 4h9a2 2 0 0 1 1.9 1.2L21 13.5V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 13.5h5l1.2 2.3h5.6L16 13.5h5" />
    </>,
    p,
  );

export const IconLink = (p: IconProps) =>
  svg(
    <>
      <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 1 0-5.7-5.7l-1.4 1.4" />
      <path d="M13.5 10.5a4 4 0 0 0-5.7 0L5 13.3a4 4 0 0 0 5.7 5.7l1.4-1.4" />
    </>,
    p,
  );

export const IconPlus = (p: IconProps) => svg(<path d="M12 5v14M5 12h14" />, p);

export const IconGrip = (p: IconProps) =>
  svg(
    <>
      <circle cx="9" cy="6" r="1.3" fill="currentColor" />
      <circle cx="15" cy="6" r="1.3" fill="currentColor" />
      <circle cx="9" cy="12" r="1.3" fill="currentColor" />
      <circle cx="15" cy="12" r="1.3" fill="currentColor" />
      <circle cx="9" cy="18" r="1.3" fill="currentColor" />
      <circle cx="15" cy="18" r="1.3" fill="currentColor" />
    </>,
    p,
  );
