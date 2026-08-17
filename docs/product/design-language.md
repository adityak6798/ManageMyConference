# Greenroom design language

Status: canonical | Owner: product | Last verified: 2026-08-16

Greenroom is the backstage of a conference: the run sheet and the call sheet. Every surface answers
two questions and no others — what needs me now, and when. The interface is an instrument for time
and queues, so it should make the next decision obvious, keep large collections readable, and become
visually quiet once somebody starts working. This document governs the console, role portals, public
event surfaces, and the signed-out product story. Product behavior remains in the owning `PRD-*`
specification; this document governs presentation and interaction only.

The tokens this document describes are declared once, in `apps/web/src/styles/tokens.css`, and the
controls are drawn once, in `apps/web/src/styles/controls.css`. A name not declared there does not
exist: `var(--gone)` resolves to nothing and the property is silently dropped, which is why
`tools/check-css-tokens.mjs` refuses a reference with no declaration and
`apps/web/test/tokens.test.ts` refuses a declaration going missing. The same gate refuses the
mirror case — a class a stylesheet selects on that no component names — because 26 forms once
shipped `.stack` and `.form-stack` before the rules that space them existed, and rendered with
neither.

## Principles

1. **Lead with the job.** Navigation and page titles name the work somebody came to do, not the
   domain or implementation that owns it.
2. **Prefer structure to containers.** Use whitespace, alignment, dividers, and typography before
   adding a card. A card represents one distinct object or state, never a default page wrapper.
3. **Keep state beside the action.** Validation, progress, success, failure, and stale-data notices
   render where the person acted and remain understandable without color.
4. **Make density intentional.** Tables and lists are compact enough to scan; editing surfaces open
   into a focused panel or dialog rather than expanding every row at once.
5. **Preserve the other side of the lifecycle.** Organizer, reviewer, speaker, applicant, and
   attendee surfaces use one visual grammar while optimizing their hierarchy for different jobs.
6. **Accessibility is the component contract.** Keyboard behavior, focus movement, names, live
   feedback, reduced motion, and narrow-screen behavior ship with a primitive, not afterwards.

## Foundations

### Color — one cool ramp for the whole product

There is exactly one neutral ramp, faintly green so it sits under the brand without being tinted by
it. Public pages and portals no longer swap in a warm-paper ramp: paper colour is the weakest way to
tell two surfaces apart, and swapping it meant every component was authored against two grounds it
could not see. Public surfaces differentiate by measure, rhythm, scale, and — where one is
configured — the accent.

- **Neutrals.** `--ink` headings and primary text · `--ink-2` body copy that is not a heading ·
  `--slate` secondary text, gutter figures, descriptions, every metadata label · `--ink-4` disabled
  glyphs, and a placeholder only where it is decoration over a real value · `--paper` page canvas ·
  `--surface` working surfaces, and the correct value for text on a dark ground · `--surface-2` the
  inset ground of a header row or nested field · `--rule` hairlines · `--rule-strong` control
  borders.
- **`--ink-4` never carries text a reader has to read**, and a control's placeholder usually is
  that text: until something is chosen, the placeholder is the entire visible content of a
  `Select` or `Combobox`. So `.select-value.is-placeholder` and `.combobox-input::placeholder` set
  in `--slate` (5.95:1); at `--ink-4` they measured 2.81:1 on white and axe reported a serious
  contrast violation on the public call for proposals, where that placeholder was the whole of two
  required questions. Disabled controls keep `--ink-4`, which WCAG exempts, and so does
  `.datetime-value.is-empty`, because that span is `aria-hidden` decoration over a real native
  input that carries the value itself.
- **Green.** `--green` marks the primary action, the current navigation item, the focus ring, and
  the selected rail. Nothing else, and never a page wash. `--green-strong` is hover and pressed on a
  green ground, `--green-soft` a selected row or rail tint, `--green-line` a hairline on that tint.
- **Accent.** `--accent` is a slot, not a colour: it defaults to the green ramp, and a surface fills
  it inline on its own container — never at `:root` — where the surface has a colour to fill it
  with. Two do: an organization portal from its stored `primaryColor`, and an embed from the option
  the host page's snippet supplies. **The public event page cannot**, because the event projection
  carries no brand colour at all; that is `GAP-032`, not an oversight in the stylesheet. A surface
  that fills `--accent` gets `--accent-strong` derived for it on `.public-shell` / `.public-state`;
  `--accent-soft` is declared and deliberately unused, because a pale wash of the accent behind a
  region is the same colour saying something it does not mean.
- **Status.** Success, warning, danger, information, and neutral are the only other colours. Each is
  a foreground and its own ground (`--warn-fg` / `--warn-bg`) and is only ever used as the pair;
  every pair clears 4.5:1. Every state also carries a label or an icon, so none depends on colour.
- **No surface repaints another.** `:root:has(…)` is banned in the token layer. It let a CFP preview
  mounted inside the console swap the ramp for every page behind it.

### Typography

- Product UI resolves entirely from system faces, so the app stays fast and works with no font
  request. Display and body share the family; hierarchy comes from size, weight, spacing, and
  measure rather than a decorative face.
- **Four weights and only four**: 400, 500, 600, 700, named `--fw-regular`, `--fw-medium`,
  `--fw-semibold`, `--fw-bold`. Never write a numeric weight. CSS Fonts 4 rounds a requested weight
  to the nearest face a family ships, and the Windows and Linux members of the stack ship Regular
  and Bold only — the eleven weights this replaced collapsed into one bold off Apple hardware.
  Labels, nav items, buttons, summaries, pills, and table headers take `--fw-medium`; headings,
  titles, names, and the current tab take `--fw-semibold`; `--fw-bold` is reserved for single-letter
  monograms and the brandmark.
- **Scale**: 11 / 12 / 13 / 15 / 17 / 20 / 24 / 28 / 36. Body is 15, operational metadata 12–13 but
  never as the only carrier of a critical state, page titles 28, and a metric figure sets at 24 so a
  number reads as data under its title rather than competing with it.
- **Tracking is negative or nothing, never positive**: `-0.02em` at 20px and above, zero below.
  `text-transform: uppercase` is banned product-wide — paired with positive tracking it was the
  loudest dated tell in the interface, and the cue gutter now does the work its eyebrows did.
- **The mono face is a first-class UI role.** Every figure that is a *measurement* — a time, a
  count, a duration, a version, a reference, a slot range — sets in `--font-mono` at 12–13px,
  `--fw-medium`, `font-variant-numeric: tabular-nums`, `--tracking-figure`. The `.figure` class is
  that recipe, declared once in `tokens.css` so the console shell, the control tier, the public
  pages and the portal all reach it. With no display face available, this is where the product's
  character lives.
- Long prose stays near a 68-character measure (`--measure`).

### Space, shape, and elevation

- Layout follows a 4px base scale (`--s-1` … `--s-16`). Dense rows use 8–12px internally, page
  regions 20–24px, editorial sections 48–64px.
- **Radius**: `--r-sm` 4px for a checkbox or chip, `--r-md` 6px for every control without exception,
  `--r-lg` 10px for a card, panel, popover, or drawer, `--r-full` for status pills only.
- **One control height.** `--control-h` 34px, `--control-h-sm` 28px, applied through `min-height` to
  button, `.btn`, input, textarea, select, the date trigger, and the icon button. A single topbar
  used to hold four controls at three different heights, which is what made the console look
  assembled rather than designed.
- **One border depth.** A bordered thing may not contain another bordered thing. A card inside a
  card, and a stat inside a card, lose their border, radius, and background; use a heading and space
  instead.
- **Elevation is for things that float over the page**: `--shadow-md` for popovers, `--shadow-lg`
  for dialogs and drawers. A card gets a hairline and nothing else. There is no card shadow.
- **Stacking order**, in the one order the product uses. Anchored to the page: 1 sticky table
  header · 8 the agenda's board bar · 10 the call-for-proposals status bar · 19 the shell's own
  pinned alert. Floating over it: 20 topbar · 30 account popover · 40 select, combobox, and menu
  popovers, and the mobile navigation scrim · 50 command palette and the mobile navigation drawer ·
  100 skip link. Everything from 8 to 19 is a band that sticks *under* the topbar at `--topbar-h`
  and scrolls beneath it, which is what those three values buy. The drawer is a native `<dialog>`
  and rises above all of them in the top layer, which is why it needs no z-index of its own. A new
  surface takes one of these numbers rather than inventing a value.

### The cue gutter — the signature

One fixed 56px monospace measure column runs down the left edge of every queue, list, table, and
board row, separated from the content by a continuous hairline spine that does not break between
rows. It carries the single figure that row is *about* — a time, a count, a duration, an index, a
state glyph — in `--font-mono` at 12px, `--fw-medium`, tabular figures, `--slate`. The current row
takes its figure in `--ink` and its spine segment in 2px `--green`.

It replaces rather than decorates. The agenda board's frozen time column *is* the gutter — `.gutter`
supplies the 56px track and the spine, and the board adds the horizontal freeze, as it now does the
vertical one for the column headings: the two questions that board answers are "when" and "where",
and neither may scroll away while the other is read. The setup checklist and the work-waiting list on the
Overview are `GutterRow`s, and communications' delivery history is the table form of the same thing:
`th.gutter` / `td.gutter` carrying the attempt count. It is the reason uppercase eyebrows, 01/02/03
ornaments, and card titlebars could all be deleted without pages losing structure: the spine does
that job with information instead of chrome.

The restraint is the point, and it is enforced in the API — `measure` is a required prop. A row with
no measure gets no gutter, and a settings form never has one. If you find yourself passing "—", the
row does not want a gutter. Two surfaces show the rule working rather than failing: the operational
inbox and the search results are plain rows, because an inbox item and a search hit are about a
title and a destination and carry no figure at all. The Overview's counts are the other side of it —
five figures that are not a queue, so they set as a `.measure-strip`: one line of monospace metrics
under hairline separators, not five bordered tiles and not five gutter rows with nothing to the
right of the spine.

## Components and composition

- **Page header:** one title, optional short context, and no more than one primary action.
- **Section, not card, is the default page region:** a sentence-case label, one line of description,
  optional actions, then content. No border, no background, no shadow. Reach for a card only when
  the region is one distinct object or state — a record being edited, a single result.
- **Hub tabs:** represent stable sibling jobs and remain addressable in the URL. Tabs never hide a
  permission refusal the product is required to explain.
- **Toolbar:** filters and search precede bulk actions; destructive actions stay visually separate.
- **Buttons:** an unclassed `<button>` is a reset, not a primary. `primary` is green and appears once
  per region; `secondary` and `ghost` carry everything else; `danger` is outlined at rest and only
  fills for the confirming press; `link` is an action that reads inside a sentence. Add `small` for
  the 28px height. Every control is one height.
- **List/detail:** selection remains visible in the list and opens one focused detail region. Queues
  with long lists use route state or the shared drawer so the selected detail becomes the focused
  view; there is no list/detail primitive, because none was ever called.
- **Tables:** sticky headers, tabular numbers, restrained row hover, one selection treatment (a green
  leading rail over the selected tint, set with `aria-selected`), and a card restack below 780px so
  no column hides behind a horizontal swipe. Cells carry `data-label` so a restacked row keeps its
  column captions. A first column that carries a measure is the cue gutter.
- **Controls come from the tier, not from the platform.** `ui/fields.tsx` and `ui/menu.tsx` own
  every control that asks for a value or runs a command: `Field` (the label, hint, error and
  `aria-describedby` wiring every other control composes), `Select` and `Combobox` (the WAI-ARIA
  select-only combobox, with `Combobox` adding a filter for a list too long to scan — roughly 400
  timezones is the length a native popup is worst at), `Checkbox`, `Radio` and `RadioGroup`,
  `DateTimeField` with its `DateField` / `TimeField` shorthands, `SegmentedControl` for a bounded
  choice worth showing in full, `CopyableSecret` for a value that exists to be copied once, and
  `Menu` for the once-a-season actions that used to line up as buttons. They replaced 73 native
  `<select>`s and 21 native date inputs, each of which was drawn by the reader's operating system
  and by no rule in this document. A native control that a lane has not converted still gets the
  reset and the height, so it looks like the tier rather than like Windows; it does not get the
  tier's keyboard rules, which is the reason to convert it.
- **A menu is not a select.** A menu runs actions and holds no value; a select holds a value and
  runs nothing. They live in separate modules for that reason, and a surface reaching for one when
  it means the other is the mistake the split exists to make visible.
- **Forms:** labels remain visible; helper text explains constraints before failure; errors attach to
  their field and an action-level summary appears when several fields fail.
- **A destructive or irreversible action is confirmed in a drawer**, not in a `window.confirm` and
  not on the press. The confirmation states what is about to happen in the reader's terms, its
  dismissing control says what happens instead ("Keep it private", not "Cancel"), its confirming
  control carries the weight of the act — `danger` where something is destroyed, `primary` where
  something merely becomes public — and the drawer refuses its own Escape while the request is in
  flight. A confirmation raised from inside an editor drawer leaves two dialogs open at once, so it
  carries its own heading and is addressed by it.
- **Dialogs and drawers:** have one labelled heading, an explicit close control, Escape behavior,
  focus restoration, and blocked dismissal while an irreversible request is in flight.
- **Status and feedback:** use a pill for terse state, a notice for an actionable interruption, and
  a live region for asynchronous outcomes. Toast-only feedback is insufficient.
- **Loading:** preserve layout with a skeleton shaped like the data — rows, tiles, fields, a page.
  A read that fails names what did not load and offers the retry. A refresh over data already on
  screen is `aria-busy`, not a second skeleton. Never show an empty state while the first read is
  unresolved, and never render the bare string "Loading…".
- **Empty states:** say why the area is empty and name the next permitted action. Every empty state
  carries its own icon; one inbox glyph for every empty area in the product says nothing. A refusal
  is not an empty state — it names the missing capability and who grants it — and a finished action
  reports its outcome with the follow-on step attached.

## Icons

- One glyph, one meaning. Every navigation destination has its own icon, because a set where one
  gear stood for Members, Webhooks, API clients, and Settings reads as placeholder art.
- The organizer sidebar is job hubs rather than workspace routes, so the icons a reader sees are:
  Overview `IconDashboard` · Inbox `IconInbox` · Reports `IconReport`, then *Run of show* — Program
  `IconForm` · People `IconSpeakers` · Schedule `IconCalendar` — then *Audience* — Communications
  `IconSend` · Publish `IconBroadcast` — then Settings `IconSettings` and, for an account that may
  create one, Create another event `IconPlus`. A hub shares its glyph with the workspace it opens
  on, which is the one place two things hold one icon on purpose.
- Every workspace module still declares its own, because a reviewer and a speaker navigate to
  theirs directly and the command palette lists them all: Review and submissions `IconReview` ·
  Speaker portal `IconTask` · Call for proposals `IconForm` · Sessions and speakers `IconSessions` ·
  Agenda `IconCalendar` · Speaker CRM `IconPipeline` · Speaker directory `IconSpeakers` · Members
  `IconMembers` · Roles and access `IconShield` · API clients `IconKey` · Webhooks `IconWebhook` ·
  Publishing `IconBroadcast` · Portals `IconGlobe` · Event templates `IconCopy` · Activity
  `IconClock` · Search `IconSearch`.
- Glyphs are drawn on a 20-unit grid at 1.5 stroke and default to `size = 20`, so a navigation icon
  renders 1:1 instead of resolving strokes to 1.13 device pixels. Icons are decorative and stay
  `aria-hidden`; their name lives in adjacent text or on the interactive parent.
- A navigation icon takes a colour decision, not an opacity: `--slate` at rest, inheriting the item's
  colour when it is current. Fading a glyph to 75% also fades whatever the item sits on.

## Vocabulary and error copy

- **No surface prints a raw enum or a permission token.** `apps/web/src/ui/vocabulary.ts` holds the
  shared maps — proposal status, submitter proposal state, delivery state, site state, session
  publication state, report dataset, embed view — with a tone beside each state so the same state is
  never amber on one screen and grey on the next. An event's own configured status labels win over
  the shared floor; a key nothing recognises is spelled out, never printed with its underscores.
- **A permission is named with its consequence.** Every capability carries a plain-language label
  *and* one line saying what granting it lets somebody do, because an admin ticking a box on an API
  client is deciding what a stranger's credential may reach. `reports:pii` is marked sensitive and
  its consequence is shown beside the control, never in a tooltip.
- **One voice for failure.** `describeApiFailure(reason, fallback)` returns the sentence and the
  reference separately. The message stays a sentence; the correlation reference renders as its own
  monospace `--slate` line with a copy affordance, because a reader cannot select an identifier
  glued to the end of a paragraph. The fallback names what did not happen in the reader's terms —
  "The member list could not be loaded." Errors do not apologise and are never vague about what
  happened.

## Shell and responsive behavior

- Desktop uses persistent event context, shallow job navigation, a compact utility top bar, and a
  content measure that can expand for boards and tables.
- Below 780px navigation becomes a modal drawer. The trigger exposes expanded state, Escape closes
  it, and background controls become inert. Dismissing the drawer restores focus to its trigger;
  choosing a destination moves focus to the new page content.
- Every product surface must work without horizontal page overflow at 390px. A deliberately
  scrollable board or table owns its overflow and gives a visible affordance.
- Pointer interactions have keyboard parity. Motion respects `prefers-reduced-motion`.

## Surface variants

- **Console:** neutral, dense, and task-first. It uses the smallest practical type and spacing
  values in this system.
- **Reviewer and speaker portals:** quieter than the organizer console, with one queue or task list
  leading the page and supporting material progressively disclosed.
- **Public event and CFP:** editorial spacing and, where a surface has one to fill, the `--accent`
  slot — but the same ramp, controls, status semantics, focus treatment, and responsive rules. The
  event page itself currently renders in the default green, because nothing in its projection
  carries a colour (`GAP-032`); a portal and an embed already differ.
- **Marketing and sign-in:** generous spacing, concise claims, real product proof, and deployment-
  aware calls to action. Claims distinguish implemented behavior from live third-party proof.

## Review checklist

- Is the primary job and next action clear before reading supporting copy?
- Can a repeated card be a row, section, or divider instead?
- Does every row with a gutter carry a real measure, and does every row without one lack a figure?
- Does every control that asks for a value come from the tier, or is a native one left drawn by the
  reader's operating system?
- Does every destructive or irreversible action stop and say what it is about to do?
- Are loading, empty, stale, failure, success, and permission states explicit?
- Does any label print a wire value, and does any permission appear without its consequence?
- Does keyboard order match visual order, and does focus move or return intentionally?
- Does the surface work at 390px, 768px, and desktop without page overflow?
- Are product claims and integration states no stronger than current evidence?
