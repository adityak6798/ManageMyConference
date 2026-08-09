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
const extensions = new Set([".ts", ".tsx", ".js", ".jsx"]);

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

function handledCatch(block) {
  let handled = false;
  function visit(node) {
    if (ts.isThrowStatement(node)) handled = true;
    if (ts.isCallExpression(node)) {
      const called = node.expression.getText();
      if (/^(?:logger\.(?:error|warn)|setError|reportError)$/.test(called)) handled = true;
    }
    ts.forEachChild(node, visit);
  }
  visit(block);
  return handled;
}

function handledRejectionCallback(callback) {
  if (ts.isIdentifier(callback)) return /^(?:setError|reportError)$/.test(callback.text);
  if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) return false;
  return handledCatch(callback.body);
}

export function inspectText(text, path = "fixture.ts") {
  const kind = path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const failures = [];
  function fail(node, message) {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    failures.push(`${relative(root, path)}:${line}: ${message}`);
  }
  function visit(node) {
    if (ts.isCatchClause(node)) {
      if (node.block.statements.length === 0) fail(node, "empty catch is forbidden");
      else if (
        !handledCatch(node.block) &&
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
      if (callback && !handledRejectionCallback(callback) && !hasIntent(source, node)) {
        fail(
          node,
          "rejection callback must throw, log/report, or have an adjacent ERROR-INTENT reason",
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const match of text.matchAll(/@ts-(?:ignore|expect-error)/g)) {
    const prefix = text.slice(Math.max(0, match.index - 240), match.index);
    if (!/ERROR-INTENT:\s*\S.+/.test(prefix)) {
      const node = ts.getTokenAtPosition(source, match.index);
      fail(node, "error-related TypeScript suppression requires ERROR-INTENT");
    }
  }
  for (const match of text.matchAll(/biome-ignore[^\n]*(?:noFloatingPromises|promise|error)/gi)) {
    const prefix = text.slice(Math.max(0, match.index - 240), match.index);
    if (!/ERROR-INTENT:\s*\S.+/.test(prefix)) {
      const node = ts.getTokenAtPosition(source, match.index);
      fail(node, "error-related Biome suppression requires ERROR-INTENT");
    }
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
