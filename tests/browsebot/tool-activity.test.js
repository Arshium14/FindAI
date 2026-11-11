import test from "node:test";
import assert from "node:assert/strict";
import {
  ToolActivity,
  safeArgsPreview,
  snapshotToolResult,
} from "../../findbar-ai/agent/tool-activity.js";

test("typed values and tab objects never enter argument previews", () => {
  const preview = safeArgsPreview("typeText", {
    tabId: "7",
    selector: "#q",
    text: "secret password",
    tab: { label: "must not serialize" },
  });
  assert.match(preview, /"tabId":"7"/);
  assert.match(preview, /"text":"\[redacted\]"/);
  assert.doesNotMatch(preview, /secret password|must not serialize|"tab"/);
});

test("activity updates one stable entry and records elapsed time", () => {
  let now = 100;
  const activity = new ToolActivity({ now: () => now });
  const started = activity.handle("webResearch", "loading", null, { query: "Zen" });
  now = 350;
  const finished = activity.handle("webResearch", "success", null, { query: "Zen" }, { sources: [] });
  assert.equal(started.id, finished.id);
  assert.equal(activity.snapshot().length, 1);
  assert.equal(finished.elapsedMs, 250);
  assert.equal(finished.status, "success");
});

test("declined and failed tools remain visible with honest errors", () => {
  const activity = new ToolActivity({ now: () => 10 });
  activity.handle("clickElement", "loading", null, { selector: "button" });
  const declined = activity.handle("clickElement", "declined", "User declined", { selector: "button" });
  activity.handle("inspectPage", "loading");
  const failed = activity.handle("inspectPage", "error", "tab closed");
  assert.equal(declined.status, "declined");
  assert.equal(failed.error, "tab closed");
  assert.equal(activity.snapshot()[1].status, "error");
});

test("a final callback without a loading callback creates and finishes one entry", () => {
  const activity = new ToolActivity({ now: () => 25 });
  const finished = activity.handle("inspectPage", "error", "missing target", { selector: "#gone" });
  assert.equal(finished.status, "error");
  assert.equal(finished.error, "missing target");
  assert.equal(finished.endedAt, 25);
  assert.equal(activity.snapshot().length, 1);
});

test("legacy fillForm success results are scrubbed before snapshot and saved-entry use", () => {
  const secret = "R1-FILL-SECRET-9f27";
  const args = { selector: "#password", value: secret };
  const result = {
    result: `Filled element with selector "#password" with value "${secret}".`,
  };
  const activity = new ToolActivity({ now: () => 10 });
  activity.handle("fillForm", "loading", null, args);
  const finished = activity.handle("fillForm", "success", null, args, result);

  assert.equal(
    finished.resultText,
    '{"result":"Filled element with selector \\"#password\\" with value \\"[redacted]\\"."}'
  );
  assert.deepEqual(Object.keys(finished), [
    "id",
    "tool",
    "status",
    "argsText",
    "resultText",
    "error",
    "startedAt",
    "endedAt",
    "elapsedMs",
  ]);

  const savedEntry = activity.snapshot()[0];
  const savedLog = {
    status: savedEntry.status,
    tool: savedEntry.tool,
    argsText: savedEntry.argsText,
    resultText: savedEntry.resultText,
    secs: `${(savedEntry.elapsedMs / 1000).toFixed(1)}s`,
  };
  assert.doesNotMatch(JSON.stringify({ finished, savedEntry, savedLog }), /R1-FILL-SECRET-9f27/);
  assert.deepEqual(args, { selector: "#password", value: secret });
  assert.deepEqual(result, {
    result: `Filled element with selector "#password" with value "${secret}".`,
  });
});

test("error and result previews scrub sensitive values from final-only callbacks", () => {
  const secret = "R1-ERROR-SECRET-51bd";
  const args = { selector: "#password", value: secret };
  const activity = new ToolActivity({ now: () => 10 });
  const finished = activity.handle(
    "fillForm",
    "error",
    new Error(`Could not fill "${secret}".`),
    args,
    { error: `Could not fill "${secret}".` }
  );

  assert.equal(finished.error, 'Could not fill "[redacted]".');
  assert.equal(finished.resultText, 'Error: Could not fill "[redacted]".');
  assert.doesNotMatch(JSON.stringify(activity.snapshot()), /R1-ERROR-SECRET-51bd/);
});

test("loading arguments scrub a final result when the final callback omits args", () => {
  const secret = "R1-FINAL-SECRET-73ce";
  const activity = new ToolActivity({ now: () => 10 });
  const started = activity.handle("typeText", "loading", null, {
    selector: "#login",
    typedText: secret,
  });
  const finished = activity.handle(
    "typeText",
    "success",
    null,
    null,
    `Typed "${secret}" into #login.`
  );

  assert.equal(finished.id, started.id);
  assert.equal(finished.argsText, '{"selector":"#login","typedText":"[redacted]"}');
  assert.equal(finished.resultText, 'Typed "[redacted]" into #login.');
  assert.doesNotMatch(JSON.stringify(activity.snapshot()), /R1-FINAL-SECRET-73ce/);
});

test("JSON-escaped sensitive content is scrubbed from serialized results", () => {
  const secret = 'R1-JSON-SECRET-"quoted"-\\slash-\nline';
  const escapedSecret = JSON.stringify(secret).slice(1, -1);
  const activity = new ToolActivity({ now: () => 10 });
  const finished = activity.handle("updateModFile", "success", null, { content: secret }, {
    result: `Stored ${secret}`,
  });

  assert.equal(finished.resultText, '{"result":"Stored [redacted]"}');
  assert.equal(finished.resultText.includes(escapedSecret), false);
  assert.equal(JSON.stringify(activity.snapshot()).includes(escapedSecret), false);
});

test("scrubbing precedes truncation so a partial secret cannot cross the preview limit", () => {
  const secret = "R1-TRUNCATION-SECRET-0123456789abcdef";
  const activity = new ToolActivity({ now: () => 10 });
  const finished = activity.handle(
    "fillForm",
    "success",
    null,
    { value: secret },
    `${"x".repeat(1490)}${secret}${"y".repeat(100)}`
  );

  assert.equal(finished.resultText.includes(secret.slice(0, 8)), false);
  assert.equal(finished.resultText.includes("[redacted]"), true);
  assert.match(finished.resultText, /… \[truncated \d+ chars\]$/);
});

test("empty sensitive values do not corrupt result text", () => {
  const activity = new ToolActivity({ now: () => 10 });
  const finished = activity.handle(
    "fillForm",
    "success",
    null,
    { value: "" },
    'Empty "" values stay intact'
  );

  assert.equal(finished.resultText, 'Empty "" values stay intact');
});

test("standalone result snapshots retain their existing serialization and truncation contract", () => {
  assert.equal(snapshotToolResult({ result: "ok" }), '{"result":"ok"}');
  assert.equal(snapshotToolResult("abcdef", 3), "abc… [truncated 3 chars]");
});
