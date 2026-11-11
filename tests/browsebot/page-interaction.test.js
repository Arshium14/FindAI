import test from "node:test";
import assert from "node:assert/strict";
import {
  createPageInteractionTools,
  normalizeKey,
  redactedPageResult,
  resolvePageTab,
} from "../../findbar-ai/agent/page-interaction.js";
import {
  dispatchPageKey,
  pageInteractionIsEnabled,
  pageInteractionLabelFor,
} from "../../findbar-ai/messageManager.js";

test("page tools default to selected tab and resolve referenced tab ids", () => {
  const selectedTab = { id: "selected", isConnected: true, closing: false };
  const referenced = { id: "referenced", isConnected: true, closing: false };
  assert.equal(resolvePageTab(undefined, { selectedTab, resolveTab: () => null }), selectedTab);
  assert.equal(resolvePageTab("7", { selectedTab, resolveTab: () => referenced }), referenced);
  assert.throws(
    () => resolvePageTab("missing", { selectedTab, resolveTab: () => null }),
    /closed or no longer connected/
  );
});

test("only supported keys are accepted", () => {
  assert.equal(normalizeKey("enter"), "Enter");
  assert.equal(normalizeKey("TAB"), "Tab");
  assert.equal(normalizeKey("Escape"), "Escape");
  assert.equal(normalizeKey("Backspace"), "Backspace");
  assert.throws(() => normalizeKey("F5"), /Unsupported key/);
});

test("successful typing results contain counts, never typed text", () => {
  const result = redactedPageResult("typeText", { id: "7", label: "Form" }, { length: 19 });
  assert.equal(result.tabId, "7");
  assert.equal(result.tabTitle, "Form");
  assert.match(result.result, /19 characters/);
  assert.equal(Object.hasOwn(result, "text"), false);
});

test("inspection results expose metadata but never form values", () => {
  const result = redactedPageResult(
    "inspectPage",
    { id: "7", label: "Form" },
    {
      elements: [
        {
          selector: "#q",
          tag: "input",
          type: "search",
          label: "Query",
          contentEditable: false,
          value: "must not escape",
        },
      ],
    }
  );
  assert.equal(result.elements.length, 1);
  assert.equal(result.elements[0].selector, "#q");
  assert.equal(Object.hasOwn(result.elements[0], "value"), false);
  assert.doesNotMatch(JSON.stringify(result), /must not escape/);
});

test("tab-targeted tools forward explicit submission and redact typed results", async (t) => {
  const commands = [];
  const messageManager = {
    loadFrameScript() {},
    addMessageListener(_name, listener) {
      this.listener = listener;
    },
    removeMessageListener() {},
    sendAsyncMessage(_name, message) {
      commands.push(message);
      const result =
        message.command === "TypeText"
          ? { cancelled: false, length: 23 }
          : message.command === "PressKey"
            ? { key: "Enter" }
            : {};
      this.listener({ data: { ...message, result } });
    },
  };
  const referenced = {
    id: "7",
    label: "Form",
    isConnected: true,
    closing: false,
    linkedBrowser: { messageManager },
  };
  const previousBrowser = globalThis.gBrowser;
  globalThis.gBrowser = { selectedTab: null };
  t.after(() => {
    if (previousBrowser === undefined) delete globalThis.gBrowser;
    else globalThis.gBrowser = previousBrowser;
  });
  const tools = createPageInteractionTools(() => referenced);
  const signal = new AbortController().signal;
  const secret = "sensitive typed value";
  const typed = await tools.typeText.execute(
    { tabId: "7", selector: "#q", text: secret, clear: true },
    { signal }
  );
  const clicked = await tools.clickElement.execute({ tabId: "7", selector: "#save" });
  const submitted = await tools.clickElement.execute({ tabId: "7", selector: "#save", submit: true });
  const pressed = await tools.pressKey.execute({ tabId: "7", key: "enter", submit: true });

  assert.equal(clicked.error, undefined);
  assert.equal(submitted.error, undefined);
  assert.equal(pressed.error, undefined);
  assert.equal(commands[0].data.text, secret);
  assert.equal(commands[0].data.clear, true);
  assert.equal(commands[1].data.submit, false);
  assert.equal(commands[2].data.submit, true);
  assert.equal(commands[3].data.submit, true);
  assert.match(typed.result, /23 characters/);
  assert.doesNotMatch(JSON.stringify(typed), /sensitive typed value/);
});

test("unavailable referenced tabs are honest tool failures", async () => {
  const tools = createPageInteractionTools(() => null);
  const result = await tools.inspectPage.execute({ tabId: "missing" });
  assert.match(result.error, /closed or no longer connected/);
});

function editableLabelFixture(tagName, textContent, attributes = {}) {
  return {
    tagName,
    textContent,
    labels: [],
    isContentEditable: tagName === "DIV",
    value: tagName === "DIV" ? undefined : textContent,
    getAttribute(name) {
      return attributes[name] ?? null;
    },
  };
}

test("inspection labels never fall back to editable text content", () => {
  const textarea = editableLabelFixture("TEXTAREA", "default or typed secret", {
    placeholder: "Private notes",
  });
  const input = editableLabelFixture("INPUT", "typed input secret", { name: "query" });
  const editable = editableLabelFixture("DIV", "typed editor secret");

  assert.equal(pageInteractionLabelFor(textarea), "Private notes");
  assert.equal(pageInteractionLabelFor(input), "query");
  assert.equal(pageInteractionLabelFor(editable), "");
  assert.equal(
    pageInteractionLabelFor(editableLabelFixture("BUTTON", "Save changes")),
    "Save changes"
  );
});

test("associated labels exclude nested editable contents", () => {
  const clone = {
    textContent: "Notes nested typed secret",
    querySelectorAll(selector) {
      assert.equal(selector, "input, textarea, select, [contenteditable]");
      return [
        {
          remove() {
            clone.textContent = "Notes";
          },
        },
      ];
    },
  };
  const textarea = editableLabelFixture("TEXTAREA", "nested typed secret");
  textarea.labels = [
    {
      textContent: clone.textContent,
      cloneNode(deep) {
        assert.equal(deep, true);
        return clone;
      },
    },
  ];

  assert.equal(pageInteractionLabelFor(textarea), "Notes");
});

test("enabled checks use :disabled semantics for fieldset-disabled controls", () => {
  const control = {
    disabled: false,
    matches(selector) {
      assert.equal(selector, ":disabled");
      return true;
    },
    getAttribute() {
      return null;
    },
  };
  assert.equal(pageInteractionIsEnabled(control), false);
});

class FakeKeyboardEvent {
  constructor(type, init) {
    Object.assign(this, init, { type });
  }
}

function keyTarget(name, log, cancelledTypes = []) {
  return {
    focus() {
      log.push(`focus:${name}`);
    },
    dispatchEvent(event) {
      log.push(`${event.type}:${name}`);
      return !cancelledTypes.includes(event.type);
    },
  };
}

function fakeKeyContent(activeElement) {
  return {
    KeyboardEvent: FakeKeyboardEvent,
    document: { activeElement },
  };
}

test("Enter requestSubmit runs after keypress and before keyup", () => {
  const log = [];
  const target = keyTarget("input", log);
  const content = fakeKeyContent(target);
  const form = {
    requestSubmit() {
      log.push("requestSubmit");
    },
  };
  const result = dispatchPageKey(content, target, "Enter", { form, submit: true });

  assert.deepEqual(log, [
    "focus:input",
    "keydown:input",
    "keypress:input",
    "requestSubmit",
    "keyup:input",
  ]);
  assert.equal(result.submitted, true);
});

test("Tab moves focus before dispatching keyup to the new target", () => {
  const log = [];
  const first = keyTarget("first", log);
  const second = keyTarget("second", log);
  const content = fakeKeyContent(first);
  const result = dispatchPageKey(content, first, "Tab", {
    moveFocus() {
      second.focus();
      content.document.activeElement = second;
      return true;
    },
  });

  assert.deepEqual(log, ["focus:first", "keydown:first", "focus:second", "keyup:second"]);
  assert.equal(result.focusMoved, true);
});

test("cancelled keys and Enter without submit never request submission", () => {
  for (const { cancelledTypes, submit, expected } of [
    {
      cancelledTypes: ["keydown"],
      submit: true,
      expected: ["focus:input", "keydown:input", "keyup:input"],
    },
    {
      cancelledTypes: ["keypress"],
      submit: true,
      expected: ["focus:input", "keydown:input", "keypress:input", "keyup:input"],
    },
    {
      cancelledTypes: [],
      submit: false,
      expected: ["focus:input", "keydown:input", "keypress:input", "keyup:input"],
    },
  ]) {
    const log = [];
    const target = keyTarget("input", log, cancelledTypes);
    const form = {
      requestSubmit() {
        log.push("requestSubmit");
      },
    };
    dispatchPageKey(fakeKeyContent(target), target, "Enter", { form, submit });
    assert.deepEqual(log, expected);
  }
});

test("Backspace deletion remains between keydown and keyup", () => {
  const log = [];
  const target = keyTarget("editor", log);
  const result = dispatchPageKey(fakeKeyContent(target), target, "Backspace", {
    deleteBackward() {
      log.push("deleteBackward");
      return { cancelled: false, deleted: true };
    },
  });

  assert.deepEqual(log, ["focus:editor", "keydown:editor", "deleteBackward", "keyup:editor"]);
  assert.equal(result.deleted, true);
});
