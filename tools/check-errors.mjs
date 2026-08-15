// @spec ARC-ERR-001 ENG-CODE-001
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url).pathname;
const ignored = new Set([
  ".git",
  ".venv",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    if (ignored.has(name)) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return files(path);
    const extension = name.slice(name.lastIndexOf("."));
    return extensions.has(extension) ? [path] : [];
  });
}

function hasIntent(source, node) {
  const start = Math.max(
    0,
    source.getLineStarts()[source.getLineAndCharacterOfPosition(node.pos).line - 2] ?? 0,
  );
  const leading = source.text.slice(start, node.getStart(source));
  return /ERROR-INTENT:\s*\S.+/.test(leading);
}

/**
 * A bare `announce(...)` only counts when the file actually binds it to a feedback announcer.
 * Without that, any unrelated local helper named `announce` would satisfy the gate and a catch
 * could silently discard an error.
 *
 * Two bindings count. The first is the hook itself. The second is a component that is *given*
 * one — a panel that shares its page's single live region rather than adding a second — which is
 * recognised by its declared parameter type rather than by the name alone, so an unrelated
 * `announce` still fails. The type is the announcer's exact signature: an unrelated function that
 * happens to take `tone: "success" | "error"` first is the announcer, whatever it is called.
 */
function bindsFeedbackAnnounce(text) {
  const source = text ?? "";
  return (
    /\{[^}]*\bannounce\b[^}]*\}\s*=\s*useActionFeedback\s*\(/.test(source) ||
    /\bannounce\s*:\s*\(\s*tone\s*:\s*"success"\s*\|\s*"error"/.test(source)
  );
}

function handledCatch(block, text) {
  let handled = false;
  function visit(node) {
    if (
      node !== block &&
      (ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node))
    )
      return;
    if (ts.isThrowStatement(node)) handled = true;
    if (ts.isCallExpression(node)) {
      const called = node.expression.getText();
      if (/^(?:logger\.(?:error|warn)|setError|reportError)$/.test(called)) handled = true;
      // `<name>Feedback.announce("error", …)` renders the failure next to the control that
      // caused it and publishes it to a live region, so it reports rather than suppresses.
      // The first argument must be the literal "error": announcing a success in a catch
      // block is exactly the silent discard this gate exists to catch.
      // See docs/architecture/error-observability.md.
      const viaHandle = /^\w*[Ff]eedback\.announce$/.test(called);
      const viaBinding = called === "announce" && bindsFeedbackAnnounce(text);
      if (viaHandle || viaBinding) {
        const [tone] = node.arguments;
        if (tone && ts.isStringLiteralLike(tone) && tone.text === "error") handled = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(block);
  return handled;
}

function handledRejectionCallback(callback, text) {
  if (ts.isIdentifier(callback)) return /^(?:setError|reportError)$/.test(callback.text);
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return false;
  return handledCatch(callback.body, text);
}

export function inspectText(text, path = "fixture.ts") {
  const kind = path.endsWith("x")
    ? ts.ScriptKind.TSX
    : path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const failures = [];
  const nulPosition = text.indexOf("\0");
  if (nulPosition !== -1) {
    const line = source.getLineAndCharacterOfPosition(nulPosition).line + 1;
    failures.push(`${relative(root, path)}:${line}: NUL byte is forbidden in source text`);
  }
  function fail(node, message) {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    failures.push(`${relative(root, path)}:${line}: ${message}`);
  }
  function visit(node) {
    if (ts.isCatchClause(node)) {
      if (node.block.statements.length === 0) fail(node, "empty catch is forbidden");
      else if (
        !handledCatch(node.block, text) &&
        !/ERROR-INTENT:\s*\S.+/.test(node.block.getText(source))
      ) {
        fail(node, "suppressed catch requires handling or an ERROR-INTENT reason");
      }
    }
    if (ts.isVoidExpression(node) && !hasIntent(source, node)) {
      fail(node, "intentional non-await requires an adjacent ERROR-INTENT reason");
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch"
    ) {
      const callback = node.arguments[0];
      if (callback && !handledRejectionCallback(callback, text) && !hasIntent(source, node)) {
        fail(
          node,
          "rejection callback must throw, log/report, or have an adjacent ERROR-INTENT reason",
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, kind, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      token !== ts.SyntaxKind.SingleLineCommentTrivia &&
      token !== ts.SyntaxKind.MultiLineCommentTrivia
    )
      continue;
    const comment = scanner.getTokenText();
    const position = scanner.getTokenPos();
    const line = source.getLineAndCharacterOfPosition(position).line;
    const priorLineStart = source.getLineStarts()[Math.max(0, line - 1)] ?? 0;
    const adjacent = text.slice(priorLineStart, position);
    const hasAdjacentIntent = /ERROR-INTENT:\s*\S.+/.test(adjacent);
    const node = ts.getTokenAtPosition(source, position);
    if (/@ts-(?:ignore|expect-error)/.test(comment) && !hasAdjacentIntent)
      fail(node, "error-related TypeScript suppression requires ERROR-INTENT");
    if (
      /biome-ignore[^\n]*(?:noFloatingPromises|promise|error)/i.test(comment) &&
      !hasAdjacentIntent
    )
      fail(node, "error-related Biome suppression requires ERROR-INTENT");
  }
  return failures;
}

function inspect(path) {
  return inspectText(readFileSync(path, "utf8"), path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = files(root).flatMap(inspect);
  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\nSee docs/architecture/error-observability.md.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Error policy checks passed.\n");
  }
}
