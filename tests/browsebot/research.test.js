import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSearchResults, runResearch } from "../../findbar-ai/agent/research.js";

test("normalization keeps bounded unique HTTP results", () => {
  const results = normalizeSearchResults([
    { title: "One", url: "https://one.test/article", snippet: " first " },
    { title: "Duplicate", url: "https://one.test/article#comments", snippet: "duplicate" },
    { title: "Unsafe", url: "javascript:alert(1)", snippet: "bad" },
    ...Array.from({ length: 10 }, (_, i) => ({ title: `R${i}`, url: `https://r.test/${i}`, snippet: "" })),
  ]);
  assert.equal(results.length, 8);
  assert.equal(results[0].title, "One");
  assert.equal(results.some((result) => result.url.startsWith("javascript:")), false);
  assert.equal(new Set(results.map((result) => result.url)).size, results.length);
});

function fakeIO({ failRead = false, failSearch = false } = {}) {
  const closed = [];
  let next = 0;
  return {
    closed,
    async open(url) {
      const tab = { id: ++next, url, reused: false };
      if (failSearch) throw new Error("CAPTCHA");
      return tab;
    },
    async extract() {
      return Array.from({ length: 4 }, (_, i) => ({ title: `S${i}`, url: `https://s.test/${i}`, snippet: `snippet ${i}` }));
    },
    async read(tab) {
      if (failRead) throw new Error("sign-in required");
      return { title: `Read ${tab.id}`, url: tab.url, textContent: "source text" };
    },
    reused(tab) { return tab.reused; },
    async close(tab) { closed.push(tab.id); },
  };
}

test("research reads at most three sources and closes every owned tab", async () => {
  const io = fakeIO();
  const result = await runResearch(
    { query: "Zen", searchUrl: "https://search.test?q=Zen" },
    { io, signal: new AbortController().signal }
  );
  assert.equal(result.results.length, 4);
  assert.equal(result.sources.length, 3);
  assert.equal(result.sources[0].text, "source text");
  assert.deepEqual(io.closed, [1, 2, 3, 4]);
});

test("partial source failures and search failures are honest and still clean up", async () => {
  const partial = await runResearch(
    { query: "Zen", searchUrl: "https://search.test?q=Zen" },
    { io: fakeIO({ failRead: true }), signal: new AbortController().signal }
  );
  assert.equal(partial.sources[0].text, "");
  assert.match(partial.sources[0].error, /sign-in required/);
  await assert.rejects(
    runResearch(
      { query: "Zen", searchUrl: "https://search.test?q=Zen" },
      { io: fakeIO({ failSearch: true }), signal: new AbortController().signal }
    ),
    /CAPTCHA/
  );
});

test("a tab created before an open failure is cleaned by the outer finally", async () => {
  const io = fakeIO();
  io.open = async (url, { onOpen } = {}) => {
    const tab = { id: 1, url, reused: false };
    onOpen?.(tab);
    throw new Error("load failed");
  };
  await assert.rejects(
    runResearch(
      { query: "Zen", searchUrl: "https://search.test?q=Zen" },
      { io, signal: new AbortController().signal }
    ),
    /load failed/
  );
  assert.deepEqual(io.closed, [1]);
});

test("an already-aborted run opens no tabs", async () => {
  const controller = new AbortController();
  const io = fakeIO();
  controller.abort();
  await assert.rejects(
    runResearch({ query: "Zen", searchUrl: "https://search.test" }, { io, signal: controller.signal }),
    { name: "AbortError" }
  );
  assert.deepEqual(io.closed, []);
});

test("a mid-run abort closes tabs already owned by the run", async () => {
  const controller = new AbortController();
  const io = fakeIO();
  io.read = async () => {
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  };
  await assert.rejects(
    runResearch(
      { query: "Zen", searchUrl: "https://search.test?q=Zen" },
      { io, signal: controller.signal }
    ),
    { name: "AbortError" }
  );
  assert.deepEqual(io.closed, [1, 2]);
});

test("cleanup preserves a research tab reused by the user", async () => {
  const io = fakeIO();
  const originalOpen = io.open;
  io.open = async (url) => {
    const tab = await originalOpen(url);
    if (tab.id === 2) tab.reused = true;
    return tab;
  };
  await runResearch(
    { query: "Zen", searchUrl: "https://search.test?q=Zen" },
    { io, signal: new AbortController().signal }
  );
  assert.deepEqual(io.closed, [1, 3, 4]);
});
