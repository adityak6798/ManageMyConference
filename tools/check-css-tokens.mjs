// @spec ARC-001 ENG-CODE-001
//
// Keeps the stylesheets and the components that render them from drifting apart.
//
// The two defects this exists to make impossible
//   1. A `var(--token)` with no declaration and no fallback. CSS does not fail here: the
//      property is simply dropped, so a renamed token turns into a control with no border,
//      a heading with no colour, or a row with no gap — and nothing anywhere says so. The
//      design-foundation rebuild renamed --canvas, --muted, --line, --shadow-sm and the
//      whole eight-step green ramp, which is exactly the change that leaves this behind.
//   2. A class selector no component names — dead CSS left behind by a migration, which is
//      how a stylesheet grows a second, stale answer to a question the product has already
//      settled. It is the mirror of the incident that prompted this file: `.stack`, `.inline`
//      and `.form-stack` were written into 26 forms before the rules that give them their
//      spacing existed, and the forms rendered with none. Read the direction carefully — the
//      incident's own direction is the one below, and it is not covered.
//
// What it deliberately does NOT cover
//   * A class a *component* names that no stylesheet declares — the `.stack` direction. It
//     needs an oracle for the class names a component builds at runtime, which this file has
//     only in the loose form `classUsage` documents; asserting the reverse from that would
//     fail working code. Recorded as a gap in docs/quality/known-gaps.md (`GAP-033`).
//   * Whether a class is *reachable* — a component may name a class it never renders.
//     Proving that needs the render tree, and the browser suite owns behaviour.
//   * Element and attribute selectors. `.data-label` styling and `button.primary` are
//     matched through the class half; a bare `td[data-label]` is not this gate's business.
//   * The values themselves. Contrast pairs and token presence are asserted in
//     apps/web/test/tokens.test.ts, where a real CSS parser and jsdom are available.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url).pathname;

/** Where the product's CSS lives, and what may name a class in it. */
export const STYLE_ROOTS = ["apps/web/src"];
export const SOURCE_ROOTS = ["apps/web/src"];
export const SOURCE_FILES = ["apps/web/index.html"];
const STYLE_EXTENSIONS = [".css"];
const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "coverage", "test-results"]);

/**
 * Classes a stylesheet declares that no component names yet, and why that is not drift.
 *
 * Every entry is checked in both directions: a class that stops being declared, or starts
 * being used, fails the gate as a stale exemption. The list is meant to shrink — an entry
 * is a promise that somebody is coming back to it, not a permanent silence.
 */
export const EXEMPT_CLASSES = new Map([
  [
    "control-icon",
    "controls.css publishes the square glyph button for the workspaces that still hand-roll one; the first adopter removes this entry.",
  ],
  [
    "spine",
    "shell.css declares the cue-gutter edge once so a surface drawing its own measure column — a table's first cell, the agenda board's time axis — reuses the line rather than redrawing it; no such surface names it yet.",
  ],
]);

function files(directory, extensions) {
  return readdirSync(directory).flatMap((name) => {
    if (IGNORED_DIRECTORIES.has(name)) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return files(path, extensions);
    return extensions.some((extension) => name.endsWith(extension)) ? [path] : [];
  });
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/**
 * Comments blanked out, keeping every byte offset so reported line numbers stay true.
 *
 * A `//` run is only taken as a comment when nothing but whitespace precedes it on its line.
 * That is deliberately narrower than the language: `href="https://…"` must survive, and a
 * trailing comment left in place can only make a class look used, never make working code
 * look dead.
 */
const withoutComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(/^[ \t]*\/\/.*$/gm, (comment) => " ".repeat(comment.length));

/** Every custom property a stylesheet declares, wherever it declares it. */
export function declaredProperties(text) {
  const names = new Set();
  for (const [, name] of withoutComments(text).matchAll(/(?:^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g))
    names.add(name);
  return names;
}

/**
 * Custom properties a component sets inline, which are declarations the CSS cannot see.
 *
 * The runtime sets `--accent` on `.public-shell` from the event's configured colour, and a
 * board sets its column geometry the same way. Both are legitimate declarations, so they
 * count.
 */
export function inlineDeclaredProperties(text) {
  const names = new Set();
  for (const [, name] of text.matchAll(/["'`](--[A-Za-z0-9_-]+)["'`]\s*:/g)) names.add(name);
  for (const [, name] of text.matchAll(/(?:^|[;"'`{\s])(--[A-Za-z0-9_-]+)\s*:\s*\$\{/g))
    names.add(name);
  return names;
}

/** Every `var()` reference, with the line it sits on and whether it carries a fallback. */
export function referencedProperties(text) {
  const clean = withoutComments(text);
  return [...clean.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g)].map((match) => ({
    name: match[1],
    fallback: match[2] === ",",
    line: lineOf(clean, match.index ?? 0),
  }));
}

/**
 * Class names this stylesheet selects on, by the line their rule opens.
 *
 * Preludes are read rather than the file parsed: text that reaches an opening brace is a
 * selector list unless it starts with `@`, and anything ended by `;` or `}` is a
 * declaration. That is enough for the CSS this repository writes, and it keeps `content:
 * ".foo"` and `background: url(a.png)` out of the results without a parser.
 */
export function selectorClasses(text) {
  const clean = withoutComments(text);
  const classes = new Map();
  let buffer = "";
  let bufferIndex = 0;
  for (let index = 0; index < clean.length; index += 1) {
    const character = clean[index];
    if (character === "{") {
      const prelude = buffer.trim();
      if (!prelude.startsWith("@"))
        for (const match of prelude
          .replace(/"[^"]*"|'[^']*'/g, "")
          .matchAll(/\.(-?[_a-zA-Z][\w-]*)/g))
          if (!classes.has(match[1])) classes.set(match[1], lineOf(clean, bufferIndex));
      buffer = "";
      continue;
    }
    if (character === "}" || character === ";") {
      buffer = "";
      continue;
    }
    if (buffer === "" && /\s/.test(character)) continue;
    if (buffer === "") bufferIndex = index;
    buffer += character;
  }
  return classes;
}

/**
 * How a component may name a class: as a literal, or as the fixed half of a template.
 *
 * `` className={`state-${delivery.state}`} `` never writes `.state-terminal` anywhere, so
 * the prefix before `${` counts as naming every class that starts with it. It is a
 * deliberately loose rule — a false "used" is a stylesheet that keeps a rule too long,
 * while a false "unused" would make the gate lie about working code.
 *
 * Loose is not the same as inert, which is why comments are blanked first. Prose is the one
 * place a class name can appear that is certainly not a use: `.spine` and `.denied` were both
 * dead rules the gate called used, because "spine" is written into four component headers
 * describing the cue gutter and "denied" into five sentences about clipboard permission. What
 * stays loose after this is a name that collides with an identifier or with unrelated string
 * content, which errs in the tolerated direction.
 */
export function classUsage(sources) {
  const text = sources.map((source) => withoutComments(source.text)).join("\n");
  const prefixes = [...text.matchAll(/([\w-]+)\$\{/g)]
    .map((match) => match[1])
    .filter((prefix) => prefix.length > 1);
  return {
    names: (name) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text),
    prefixes: new Set(prefixes),
  };
}

const usedByPrefix = (usage, name) =>
  [...usage.prefixes].some((prefix) => name !== prefix && name.startsWith(prefix));

/** Everything the stylesheets say that the components do not. Empty means they agree. */
export function analyse({ stylesheets, sources, exemptions = EXEMPT_CLASSES }) {
  const problems = [];
  const declared = new Set();
  for (const sheet of stylesheets)
    for (const name of declaredProperties(sheet.text)) declared.add(name);
  for (const source of sources)
    for (const name of inlineDeclaredProperties(source.text)) declared.add(name);

  // Sources are read for `var()` too: `style={{ marginTop: "var(--s-4)" }}` drops just as
  // silently as the same typo in a stylesheet, and there is no rule anywhere for it to live in.
  for (const file of [...stylesheets, ...sources])
    for (const reference of referencedProperties(file.text)) {
      if (reference.fallback || declared.has(reference.name)) continue;
      problems.push(
        `${file.path}:${reference.line}: \`var(${reference.name})\` has no declaration and no ` +
          "fallback, so the property resolves to nothing. Declare the token or give it a fallback.",
      );
    }

  const usage = classUsage(sources);
  const exemptionsSeen = new Set();
  for (const sheet of stylesheets)
    for (const [name, line] of selectorClasses(sheet.text)) {
      const used = usage.names(name) || usedByPrefix(usage, name);
      const exemption = exemptions.get(name);
      if (exemption !== undefined) {
        exemptionsSeen.add(name);
        if (used)
          problems.push(
            `${sheet.path}:${line}: \`.${name}\` is now named by a component, so its entry in ` +
              "EXEMPT_CLASSES in tools/check-css-tokens.mjs is stale. Delete the entry.",
          );
        continue;
      }
      if (used) continue;
      problems.push(
        `${sheet.path}:${line}: \`.${name}\` is selected by the stylesheet but no component ` +
          "names it. Render it, delete the rule, or record why it is published unused in " +
          "EXEMPT_CLASSES in tools/check-css-tokens.mjs.",
      );
    }

  for (const name of exemptions.keys())
    if (!exemptionsSeen.has(name))
      problems.push(
        `EXEMPT_CLASSES in tools/check-css-tokens.mjs records \`.${name}\`, but no stylesheet ` +
          "declares it any more. Delete the entry.",
      );

  return problems;
}

const read = (path) => ({ path: relative(root, path), text: readFileSync(path, "utf8") });

export function readInputs() {
  return {
    stylesheets: STYLE_ROOTS.flatMap((directory) =>
      files(join(root, directory), STYLE_EXTENSIONS),
    ).map(read),
    sources: [
      ...SOURCE_ROOTS.flatMap((directory) => files(join(root, directory), SOURCE_EXTENSIONS)),
      ...SOURCE_FILES.map((file) => join(root, file)),
    ].map(read),
  };
}

function main() {
  const inputs = readInputs();
  const problems = analyse(inputs);
  if (problems.length > 0) {
    process.stderr.write(
      `The stylesheets and the components disagree:\n  ${problems.join("\n  ")}\n` +
        "See docs/product/design-language.md.\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `CSS token checks passed (${inputs.stylesheets.length} stylesheets against ` +
      `${inputs.sources.length} sources, ${EXEMPT_CLASSES.size} recorded exemptions).\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
