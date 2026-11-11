import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(
  new URL("../../findbar-ai/library/library.uc.js", import.meta.url),
  "utf8"
);

function functionBody(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `function ${name} must exist`);
  let depth = 0;
  let i = src.indexOf("(", start);
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  const open = src.indexOf("{", i);
  depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, j);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test("setMode switches the active session in place instead of forking a new chat", () => {
  const body = functionBody("setMode");
  assert.ok(!body.includes("newSession("), "must not create a new session");
  assert.ok(!body.includes("clearData("), "must not clear LLM history");
  assert.ok(!body.includes("renderHistory("), "must not wipe the rendered conversation");
  assert.ok(!body.includes("abortRun("), "must not kill an in-flight reply on mode switch");
  assert.match(body, /getActiveSession\(\)\.mode = mode/);
});

test("setMode persists the mode change even when no new messages exist", () => {
  const body = functionBody("setMode");
  assert.match(body, /persistSession\(true\)/);
});

test("the fork-on-switch option is gone from the library", () => {
  assert.ok(!src.includes("fork"), "no fork option should remain");
});

test("persistSession supports a forced save for mode-only changes", () => {
  const body = functionBody("persistSession");
  assert.match(body, /force/);
  assert.match(src, /function persistSession\(force = false\)/);
  assert.match(body, /if \(!force && messages\.length === activeSavedLength\) return/);
});

test("loading a saved session restores its mode without rewriting storage", () => {
  const body = functionBody("loadSession");
  assert.match(body, /setMode\(s\.mode, \{ persist: false \}\)/);
});