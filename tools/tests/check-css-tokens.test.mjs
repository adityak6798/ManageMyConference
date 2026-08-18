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

test("a var a component writes inline is checked the same way a stylesheet's is", () => {
  assert.equal(check("", 'style={{ marginTop: "var(--gone)" }}').length, 1);
  assert.deepEqual(check(":root { --s-4: 16px; }", 'style={{ marginTop: "var(--s-4)" }}'), []);
  assert.deepEqual(check("", '// style={{ marginTop: "var(--gone)" }}'), []);
});

test("a class named only in prose is not named", () => {
  // `.spine` and `.denied` were dead rules the gate called used, because both words appear in
  // component headers describing the cue gutter and clipboard permission.
  assert.equal(check(".spine { border: 0; }", "/* behind a hairline spine */").length, 1);
  assert.equal(check(".denied { border: 0; }", "  // a denied permission\n").length, 1);
  // Narrower than the language on purpose: a `//` inside a string is not a comment, so the
  // class named after one on the same line stays used.
  assert.deepEqual(check(".a { gap: 0; }", 'href="https://x" className="a"'), []);
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

test("the analysis still bites against the real corpus, not only against fixtures", () => {
  // A green gate over 20 stylesheets and 119 sources is also what a check that has stopped
  // working prints. Every fixture above passes one short source, where a class name cannot
  // collide with unrelated prose by accident; these mutations put the real corpus behind the
  // oracle and require it to still notice.
  const inputs = readInputs();
  const declaredOnly = {
    ...inputs,
    stylesheets: [...inputs.stylesheets, sheet(".zzz-named-by-nobody { gap: 0; }")],
  };
  assert.equal(analyse(declaredOnly).length, 1);

  const namedInProse = {
    ...inputs,
    stylesheets: [...inputs.stylesheets, sheet(".zzz-prose-only { gap: 0; }")],
    sources: [...inputs.sources, source("/* the zzz-prose-only rule is described, not used */")],
  };
  assert.equal(analyse(namedInProse).length, 1);

  const referenced = {
    ...inputs,
    sources: [...inputs.sources, source('style={{ color: "var(--zzz-undeclared)" }}')],
  };
  assert.equal(analyse(referenced).length, 1);
});
