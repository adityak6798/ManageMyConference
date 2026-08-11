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

test("nested functions do not handle an outer catch", () => {
  assert.notEqual(
    inspectText(
      "try { work(); } catch { const unused = () => logger.error('later'); return fallback; }",
    ),
    [],
  );
  assert.notEqual(
    inspectText("try { work(); } catch { function unused() { throw failure; } return fallback; }"),
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

test("announcing an error handles a catch, announcing anything else does not", () => {
  // The UI reports failures through a useActionFeedback handle rather than setError.
  assert.deepEqual(
    inspectText('try { work(); } catch (error) { feedback.announce("error", message(error)); }'),
    [],
  );
  assert.deepEqual(
    inspectText('try { work(); } catch (error) { pipelineFeedback.announce("error", "Failed."); }'),
    [],
  );
  // A success announcement inside a catch is the silent discard this gate exists to catch.
  assert.notEqual(
    inspectText('try { work(); } catch (error) { feedback.announce("success", "Saved."); }'),
    [],
  );
  assert.notEqual(inspectText("try { work(); } catch (error) { announce(); }"), []);
  assert.notEqual(
    inspectText('try { work(); } catch (error) { unrelated.announce("error"); }'),
    [],
  );
});

test("a bare announce only counts when it is destructured from useActionFeedback", () => {
  const hook = "const { announce } = useActionFeedback();\n";
  assert.deepEqual(
    inspectText(`${hook}try { work(); } catch (error) { announce("error", "Failed."); }`),
    [],
  );
  // An unrelated local helper that happens to be called announce must not satisfy the gate.
  assert.notEqual(
    inspectText('try { work(); } catch (error) { announce("error", "Failed."); }'),
    [],
  );
  assert.notEqual(
    inspectText(`${hook}try { work(); } catch (error) { announce("success", "Saved."); }`),
    [],
  );
});
