// @acceptance ACC-HARNESS ACC-DEMO-SMOKE
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The token layer as text.
 *
 * jsdom applies no cascade, so a token's value is only observable from what the stylesheet
 * declares. The runner can be started from the repository root or from this workspace, so
 * the file is found by trying both roots rather than by trusting one working directory —
 * the same approach design-foundation.test.tsx takes to shell.css.
 */
const tokensCss = readFileSync(
  ["apps/web/src/styles/tokens.css", "src/styles/tokens.css"].find(existsSync) ?? "",
  "utf8",
);

const withoutComments = tokensCss.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every custom property declared on the base `:root`, which is where the ramp lives. */
const rootBlock = /:root\s*\{([\s\S]*?)\}/.exec(withoutComments)?.[1] ?? "";
const declarations = new Map<string, string>(
  [...rootBlock.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)].map((match) => [
    match[1] as string,
    (match[2] as string).trim(),
  ]),
);

/** A token's value with `var()` indirection followed, so `--ok-fg` resolves to the green. */
function resolve(name: string, seen = new Set<string>()): string {
  const value = declarations.get(name);
  if (value === undefined) throw new Error(`No token declares ${name}`);
  const reference = /^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/.exec(value);
  if (!reference) return value;
  const target = reference[1] as string;
  if (seen.has(target)) throw new Error(`Token cycle through ${target}`);
  seen.add(target);
  return resolve(target, seen);
}

const channel = (part: number) =>
  part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;

/** WCAG relative luminance of a `#rrggbb` token. */
function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`Not a six-digit hex colour: ${hex}`);
  const digits = match[1] as string;
  const [red, green, blue] = [0, 2, 4].map((offset) =>
    channel(Number.parseInt(digits.slice(offset, offset + 2), 16) / 255),
  ) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

const contrast = (foreground: string, background: string) => {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
};

/**
 * The names the component tier is written against.
 *
 * A token that disappears does not fail a build: `var(--gone)` resolves to nothing and the
 * property is silently dropped, so a control loses its border and nobody is told. This list
 * is the contract every stylesheet and every lane codes against — `tools/check-css-tokens.mjs`
 * catches a *reference* with no declaration, and this catches a declaration going missing
 * from the one file that is allowed to make it.
 */
const REQUIRED_TOKENS = [
  "--font-ui",
  "--font-display",
  "--font-mono",
  "--fw-regular",
  "--fw-medium",
  "--fw-semibold",
  "--fw-bold",
  "--text-2xs",
  "--text-xs",
  "--text-sm",
  "--text-base",
  "--text-md",
  "--text-lg",
  "--text-xl",
  "--text-2xl",
  "--text-3xl",
  "--leading-tight",
  "--leading-snug",
  "--leading-normal",
  "--tracking-tight",
  "--tracking-figure",
  "--s-1",
  "--s-2",
  "--s-3",
  "--s-4",
  "--s-5",
  "--s-6",
  "--s-8",
  "--s-10",
  "--s-12",
  "--s-16",
  "--r-sm",
  "--r-md",
  "--r-lg",
  "--r-full",
  "--control-h",
  "--control-h-sm",
  "--cue-w",
  "--cue-gap",
  "--cue-spine",
  "--cue-spine-active",
  "--ink",
  "--ink-2",
  "--ink-4",
  "--slate",
  "--paper",
  "--surface",
  "--surface-2",
  "--rule",
  "--rule-strong",
  "--green",
  "--green-strong",
  "--green-soft",
  "--green-line",
  "--accent",
  "--accent-strong",
  "--accent-soft",
  "--ok-fg",
  "--ok-bg",
  "--warn-fg",
  "--warn-bg",
  "--danger-fg",
  "--danger-bg",
  "--info-fg",
  "--info-bg",
  "--neutral-fg",
  "--neutral-bg",
  "--focus",
  "--focus-ring",
  "--shadow-md",
  "--shadow-lg",
  "--sidebar-w",
  "--topbar-h",
  "--measure",
] as const;

/** Every status is a foreground and its own ground, and is only ever used as the pair. */
const STATUS_PAIRS = [
  ["--ok-fg", "--ok-bg"],
  ["--warn-fg", "--warn-bg"],
  ["--danger-fg", "--danger-bg"],
  ["--info-fg", "--info-bg"],
  ["--neutral-fg", "--neutral-bg"],
] as const;

describe("design tokens", () => {
  it("declares every token the component tier is written against", () => {
    expect(REQUIRED_TOKENS.filter((token) => !declarations.has(token))).toEqual([]);
  });

  it("keeps the four weights and no other, so the hierarchy survives off Apple hardware", () => {
    // CSS Fonts 4 rounds a requested weight to the nearest face the family ships, and the
    // Windows and Linux members of the stack ship Regular and Bold only. 550 and 620 both
    // resolved to Bold there, which is how eleven declared weights rendered as one.
    expect(
      ["--fw-regular", "--fw-medium", "--fw-semibold", "--fw-bold"].map((token) => resolve(token)),
    ).toEqual(["400", "500", "600", "700"]);
  });

  it("sets every status foreground legibly on its own ground", () => {
    for (const [foreground, background] of STATUS_PAIRS)
      expect(
        contrast(resolve(foreground), resolve(background)),
        `${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
  });

  it("sets reader-facing neutral text legibly on both grounds", () => {
    // --slate carries gutter figures, metadata and descriptions, so it is body text and is
    // held to body text's ratio. --ink-4 is deliberately absent: it is for placeholders and
    // disabled glyphs, and never for something a reader has to read.
    for (const ground of ["--paper", "--surface", "--surface-2"])
      for (const text of ["--ink", "--ink-2", "--slate"])
        expect(contrast(resolve(text), resolve(ground))).toBeGreaterThanOrEqual(4.5);
  });

  it("never repaints the console from a page's own content", () => {
    // `:root:has(.public-shell)` swapped the whole neutral ramp when a public surface was
    // mounted, so opening the CFP composer's preview inside the console repainted every
    // page behind it. A surface differentiates itself on its own container now.
    expect(withoutComments).not.toContain(":root:has(");
  });

  it("holds one neutral ramp, with the deleted spellings gone for good", () => {
    // Each of these resolved to a colour a stylesheet still asked for after the rebuild;
    // reintroducing one would give the product a second answer to "which grey is this".
    for (const gone of [
      "--canvas",
      "--muted",
      "--ink-3",
      "--line",
      "--line-strong",
      "--green-500",
      "--green-600",
      "--green-900",
      "--clay-600",
      "--r-xl",
      "--shadow-sm",
    ])
      expect(declarations.has(gone)).toBe(false);
  });
});
