// @acceptance ACC-HARNESS
import assert from "node:assert/strict";
import test from "node:test";
import { inspectText } from "../check-errors.mjs";

test("rejects a NUL byte in source text", () => {
  const nul = String.fromCharCode(0);
  assert.ok(inspectText(`const key = \`left${nul}right\`;`).length > 0);
  assert.deepEqual(inspectText("const key = `left\\0right`;"), []);
});

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

test("a setter that holds a refusal reports it, and one that holds a handler does not", () => {
  // A surface may keep a refusal per row rather than at the head of the page. What it stores is
  // what it renders, so this is a report; refusing it would push a correct component towards an
  // ERROR-INTENT comment claiming a discard that is not happening.
  assert.deepEqual(inspectText("try { work(); } catch (error) { setFailure(read(error)); }"), []);
  assert.deepEqual(
    inspectText("try { work(); } catch (error) { setRowFailure({ key, failure: read(error) }); }"),
    [],
  );
  assert.deepEqual(inspectText("try { work(); } catch (error) { setLoadError(read(error)); }"), []);
  // The name has to end in Error or Failure: installing a handler is not reporting one.
  assert.notEqual(inspectText("try { work(); } catch (error) { setErrorHandler(noop); }"), []);
  assert.notEqual(inspectText("try { work(); } catch (error) { setFailureCount(0); }"), []);
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

test("an announcer received as a prop counts, and only by its declared signature", () => {
  // A panel that shares its page's one live region is handed the announcer instead of creating a
  // second one. It reports failures exactly as the owner of the region does, so refusing it would
  // push a correct component towards an ERROR-INTENT comment that says something untrue.
  const prop =
    'function Panel({ announce }: { announce: (tone: "success" | "error", t: string) => void }) {\n';
  assert.deepEqual(
    inspectText(`${prop}try { work(); } catch (error) { announce("error", "Failed."); }\n}`),
    [],
  );
  // The signature is what counts, not the name: a prop merely *called* announce still fails.
  assert.notEqual(
    inspectText(
      'function Panel({ announce }: { announce: (message: string) => void }) {\ntry { work(); } catch (error) { announce("error", "Failed."); }\n}',
    ),
    [],
  );
});
