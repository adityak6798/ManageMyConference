// @acceptance ACC-HARNESS
import assert from "node:assert/strict";
import test from "node:test";
import {
  analyse,
  declaredProperties,
  inlineDeclaredProperties,
  readInputs,
  referencedProperties,
  selectorClasses,
} from "../check-css-tokens.mjs";

const sheet = (text) => ({ path: "styles.css", text });
const source = (text) => ({ path: "Component.tsx", text });
const none = new Map();

const check = (css, tsx = "", exemptions = none) =>
  analyse({ stylesheets: [sheet(css)], sources: [source(tsx)], exemptions });

test("a var with no declaration and no fallback fails", () => {
  assert.equal(check(".a { color: var(--gone); }", '"a"').length, 1);
  assert.deepEqual(check(".a { color: var(--gone, #000); }", '"a"'), []);
  assert.deepEqual(check(":root { --ink: #101512; }\n.a { color: var(--ink); }", '"a"'), []);
});

test("a property the component sets inline counts as declared", () => {
  const css = ".public-shell { background: var(--accent); }";
  assert.equal(check(css, '"public-shell"').length, 1);
  assert.deepEqual(check(css, 'style={{ "--accent": event.color }} "public-shell"'), []);
});

test("a var reference inside a comment is not a reference", () => {
  assert.deepEqual(check("/* var(--gone) */\n.a { color: red; }", '"a"'), []);
});

test("a class no component names fails, and a class one names passes", () => {
  assert.equal(check(".orphan { gap: 4px; }").length, 1);
  assert.deepEqual(check(".orphan { gap: 4px; }", 'className="orphan"'), []);
  // The defect this check exists for: the class was written into the components first.
  assert.equal(check(".stack { display: grid; }", 'className="stack-panel"').length, 1);
});

test("the fixed half of a template names every class built from it", () => {
  const css = ".state-queued { color: red; }\n.state-terminal { color: red; }";
  assert.equal(check(css).length, 2);
  assert.deepEqual(check(css, `className={\`state-\${delivery.state}\`}`), []);
});

test("declarations, at-rules and quoted strings are not selectors", () => {
  const css = [
    "@media (max-width: 780px) {",
    "  .row { background: url(sprite.a.png); }",
    "}",
    '.row::after { content: ".not-a-class"; }',
  ].join("\n");
  assert.deepEqual([...selectorClasses(css).keys()], ["row"]);
  assert.deepEqual(check(css, 'className="row"'), []);
});

test("an exemption silences an unused class and fails once it is stale", () => {
  const exemptions = new Map([
    ["published", "Published for the workspaces that have not adopted it."],
  ]);
  assert.deepEqual(check(".published { gap: 4px; }", "", exemptions), []);
  // Adopted: the entry is now a silence over nothing.
  assert.equal(check(".published { gap: 4px; }", 'className="published"', exemptions).length, 1);
  // Deleted: the entry records a class the stylesheets no longer declare.
  assert.equal(check(".other { gap: 4px; }", 'className="other"', exemptions).length, 1);
});

test("the readers report positions and shapes the analysis relies on", () => {
  assert.deepEqual(
    [...declaredProperties(":root { --ink: #101512; --s-1: 4px; }")],
    ["--ink", "--s-1"],
  );
  assert.deepEqual([...inlineDeclaredProperties('{ "--cue-w": width }')], ["--cue-w"]);
  assert.deepEqual(referencedProperties("\n\n.a { color: var(--ink); }"), [
    { name: "--ink", fallback: false, line: 3 },
  ]);
  assert.deepEqual(
    [...selectorClasses("\n.a,\n.b { gap: 0; }")],
    [
      ["a", 2],
      ["b", 2],
    ],
  );
});

test("the repository's own stylesheets and components agree", () => {
  assert.deepEqual(analyse(readInputs()), []);
});
