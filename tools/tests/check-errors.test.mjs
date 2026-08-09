// @acceptance ACC-HARNESS
import assert from "node:assert/strict";
import test from "node:test";
import { inspectText } from "../check-errors.mjs";

test("rejects silent catch and permits explained suppression", () => {
  assert.notEqual(inspectText("try { work(); } catch { }"), []);
  assert.deepEqual(
    inspectText("try { work(); } catch { // ERROR-INTENT: Best-effort cleanup.\n cleanup(); }"),
    [],
  );
});

test("requires intent for explicit void", () => {
  assert.notEqual(inspectText("void operation();"), []);
  assert.deepEqual(
    inspectText("// ERROR-INTENT: Background owner reports failure.\nvoid operation();"),
    [],
  );
});

test("rejects ignored rejection callbacks", () => {
  assert.notEqual(inspectText("operation().catch(() => {});"), []);
  assert.notEqual(inspectText("operation().catch(() => fallback());"), []);
  assert.notEqual(inspectText("operation().catch(() => { return fallback; });"), []);
  assert.deepEqual(inspectText("operation().catch(setError);"), []);
  assert.deepEqual(inspectText("operation().catch((error) => logger.error(error));"), []);
});

test("arbitrary catch returns do not count as handling", () => {
  assert.notEqual(inspectText("try { work(); } catch { return fallback; }"), []);
  assert.deepEqual(inspectText("try { work(); } catch (error) { throw error; }"), []);
  assert.deepEqual(
    inspectText("try { work(); } catch (error) { logger.error(error); return fallback; }"),
    [],
  );
});

test("requires intent for error-related suppressions", () => {
  assert.notEqual(inspectText("// @ts-expect-error\noperation();"), []);
  assert.notEqual(
    inspectText("// biome-ignore lint/nursery/noFloatingPromises: later\noperation();"),
    [],
  );
});
