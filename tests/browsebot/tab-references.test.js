import test from "node:test";
import assert from "node:assert/strict";
import {
  TabReferenceController,
  insertReferenceChips,
  tokenBeforeCaret,
} from "../../findbar-ai/agent/tab-references.js";

test("tokenBeforeCaret recognizes only the active @ token", () => {
  assert.deepEqual(tokenBeforeCaret("compare @Fire", 13), {
    kind: "at",
    filter: "fire",
    start: 8,
  });
  assert.equal(tokenBeforeCaret("email me@example.com", 20), null);
  assert.equal(tokenBeforeCaret("compare @One\nand @Two", 13), null);
});

test("select and sync preserve multiple pending tab references", () => {
  const controller = new TabReferenceController({ readTab: async () => null });
  const one = { tab: { id: 1 }, title: "One", url: "https://one.test", icon: "" };
  const two = { tab: { id: 2 }, title: "Two", url: "https://two.test", icon: "" };
  let edit = controller.select(one, "compare @", 9, { start: 8 });
  edit = controller.select(two, `${edit.text}and @`, edit.caret + 5, {
    start: edit.caret + 4,
  });
  controller.pending = [one, two];
  controller.sync(edit.text);
  assert.equal(controller.pending.length, 2);
  controller.sync("compare @One only");
  assert.deepEqual(controller.pending.map((ref) => ref.title), ["One"]);
});

test("resolve reads fresh content, strips visible tokens, and limits each context block", async () => {
  const tabs = [
    { tab: { id: 1 }, title: "One", url: "https://one.test", icon: "" },
    { tab: { id: 2 }, title: "Two", url: "https://two.test", icon: "" },
  ];
  const controller = new TabReferenceController({
    readTab: async (tab) => ({
      title: tab.id === 1 ? "One fresh" : "Two fresh",
      url: `https://${tab.id}.test/fresh`,
      textContent: "abcdefgh",
    }),
  });
  controller.pending = tabs;
  const result = await controller.resolve("compare @One and @Two", { maxChars: 4 });
  assert.equal(result.prompt, "compare One and Two");
  assert.deepEqual(result.refs.map((ref) => ref.text), ["abcd\n\n[Content truncated.]", "abcd\n\n[Content truncated.]"]);
  assert.deepEqual(result.warnings, []);
});

test("resolve reports closed, unreadable, and empty tabs without failing other refs", async () => {
  const controller = new TabReferenceController({
    readTab: async (tab) => {
      if (tab.id === "closed") return null;
      if (tab.id === "empty") return { title: "Empty", url: "https://empty.test", textContent: "" };
      return { title: "Good", url: "https://good.test", textContent: "fresh" };
    },
  });
  controller.pending = [
    { tab: { id: "closed" }, title: "Closed", url: "", icon: "" },
    { tab: { id: "empty" }, title: "Empty", url: "", icon: "" },
    { tab: { id: "good" }, title: "Good", url: "", icon: "" },
  ];
  const result = await controller.resolve("@Closed @Empty @Good", { maxChars: 0 });
  assert.equal(result.refs[1].text, "fresh");
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /Closed/);
  assert.match(result.warnings[1], /No readable text/);
});

test("resolve keeps original token titles for transcript chips after fresh titles", async (t) => {
  installFakeDom(t);
  const controller = new TabReferenceController({
    readTab: async () => ({
      title: "New",
      url: "https://new.test",
      textContent: "fresh",
    }),
  });
  controller.pending = [{ tab: { id: 1 }, title: "Old", url: "https://old.test", icon: "" }];

  const result = await controller.resolve("read @Old now");
  const contentDiv = createFakeContent("read @Old now");
  insertReferenceChips(contentDiv, result.refs);

  assert.equal(result.refs[0].title, "New");
  assert.equal(result.refs[0].originalTokenTitle, "Old");
  assert.equal(contentDiv.childNodes.filter((node) => node.isChip).length, 1);
  assert.equal(serializeFakeContent(contentDiv), "read New now");
});

test("sync ignores embedded and partial reference tokens", () => {
  const controller = new TabReferenceController({ readTab: async () => null });
  controller.pending = [{ tab: { id: 1 }, title: "One", url: "", icon: "" }];

  controller.sync("email me@One and @OneTwo");

  assert.deepEqual(controller.pending, []);
});

test("sync distinguishes overlapping titles as whole reference tokens", () => {
  const controller = new TabReferenceController({ readTab: async () => null });
  const one = { tab: { id: 1 }, title: "One", url: "", icon: "" };
  const oneTwo = { tab: { id: 2 }, title: "One Two", url: "", icon: "" };
  controller.pending = [one, oneTwo];

  controller.sync("compare @One Two");
  assert.deepEqual(controller.pending.map((ref) => ref.title), ["One Two"]);

  controller.pending = [one, oneTwo];
  controller.sync("compare @One and @One Two");
  assert.deepEqual(controller.pending.map((ref) => ref.title), ["One", "One Two"]);
});

test("remove does not delete a short title inside a longer reference", () => {
  const controller = new TabReferenceController({ readTab: async () => null });
  const one = { tab: { id: 1 }, title: "One", url: "", icon: "" };
  const oneTwo = { tab: { id: 2 }, title: "One Two", url: "", icon: "" };
  controller.pending = [one, oneTwo];

  const text = controller.remove(one, "compare @One Two");

  assert.equal(text, "compare @One Two");
  assert.deepEqual(controller.pending.map((ref) => ref.title), ["One Two"]);
});

test("resolve consumes only the longest reference at an overlapping token", async () => {
  const reads = [];
  const controller = new TabReferenceController({
    readTab: async (tab) => {
      reads.push(tab.id);
      return {
        title: tab.id === 1 ? "One" : "One Two",
        url: `https://${tab.id}.test`,
        textContent: "fresh",
      };
    },
  });
  controller.pending = [
    { tab: { id: 1 }, title: "One", url: "", icon: "" },
    { tab: { id: 2 }, title: "One Two", url: "", icon: "" },
  ];

  const result = await controller.resolve("compare @One Two");

  assert.equal(result.prompt, "compare One Two");
  assert.deepEqual(result.refs.map((ref) => ref.title), ["One Two"]);
  assert.deepEqual(reads, [2]);
});

test("reference matching and removal escape regex metacharacters", async () => {
  const title = "C++ (beta) [draft]?";
  const ref = { tab: { id: 1 }, title, url: "", icon: "" };
  const controller = new TabReferenceController({
    readTab: async () => ({ title, url: "https://fresh.test", textContent: "fresh" }),
  });
  const text = `use @${title} now`;
  controller.pending = [ref];

  controller.sync(text);
  assert.equal(controller.pending.length, 1);
  const result = await controller.resolve(text);
  assert.equal(result.prompt, `use ${title} now`);
  assert.equal(result.refs.length, 1);

  controller.pending = [ref];
  assert.equal(controller.remove(ref, text), "use now");
});

class FakeTextNode {
  constructor(ownerDocument, textContent) {
    this.ownerDocument = ownerDocument;
    this.textContent = textContent;
    this.parentNode = null;
    this.parentElement = null;
    this.isText = true;
  }
}

class FakeElement {
  constructor(ownerDocument, textContent = "") {
    this.ownerDocument = ownerDocument;
    this.textContent = textContent;
    this.childNodes = [];
    this.parentNode = null;
    this.parentElement = null;
    this.isChip = false;
  }

  appendChild(child) {
    this.childNodes.push(child);
    child.parentNode = this;
    child.parentElement = this;
    return child;
  }

  insertBefore(child, before) {
    const index = this.childNodes.indexOf(before);
    this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    child.parentElement = this;
    return child;
  }

  replaceChild(replacement, child) {
    const index = this.childNodes.indexOf(child);
    this.childNodes[index] = replacement;
    replacement.parentNode = this;
    replacement.parentElement = this;
    child.parentNode = null;
    child.parentElement = null;
    return child;
  }

  closest() {
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

class FakeDocument {
  createTextNode(textContent) {
    return new FakeTextNode(this, textContent);
  }

  createTreeWalker(root) {
    const textNodes = [];
    const visit = (node) => {
      if (node.isText) textNodes.push(node);
      for (const child of node.childNodes || []) visit(child);
    };
    visit(root);
    let index = -1;
    return {
      currentNode: null,
      nextNode() {
        index += 1;
        if (index >= textNodes.length) return false;
        this.currentNode = textNodes[index];
        return true;
      },
    };
  }
}

function installFakeDom(t) {
  const previousDOMParser = globalThis.DOMParser;
  const previousNodeFilter = globalThis.NodeFilter;
  globalThis.DOMParser = class {
    parseFromString(html) {
      const chip = new FakeElement(null, html.match(/<span class="bb-ref-chip"><span>(.*?)<\/span>/)[1]);
      chip.isChip = true;
      return { body: { children: [chip], firstChild: chip }, head: { firstChild: null } };
    }
  };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  t.after(() => {
    if (previousDOMParser === undefined) delete globalThis.DOMParser;
    else globalThis.DOMParser = previousDOMParser;
    if (previousNodeFilter === undefined) delete globalThis.NodeFilter;
    else globalThis.NodeFilter = previousNodeFilter;
  });
}

function createFakeContent(text) {
  const doc = new FakeDocument();
  const contentDiv = new FakeElement(doc);
  contentDiv.appendChild(doc.createTextNode(text));
  return contentDiv;
}

function serializeFakeContent(contentDiv) {
  return contentDiv.childNodes.map((node) => node.textContent).join("");
}
