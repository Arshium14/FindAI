import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import fs from "node:fs";
import {
  AgentController,
  agentCapabilityError,
  formatTabContext,
  normalizeAgentSteps,
  READ_ONLY_TOOLS,
  UNTRUSTED_CONTENT_POLICY,
} from "../../findbar-ai/agent/controller.js";
import { PREFS } from "../../findbar-ai/utils/prefs.js";

function createServices() {
  const store = new Map();
  const prefs = {
    PREF_BOOL: 1,
    PREF_INT: 2,
    PREF_STRING: 3,
    getPrefType(key) {
      return store.get(key)?.type || 0;
    },
    getBoolPref(key, fallback) {
      const entry = store.get(key);
      return entry?.type === 1 ? entry.value : fallback;
    },
    getIntPref(key, fallback) {
      const entry = store.get(key);
      return entry?.type === 2 ? entry.value : fallback;
    },
    getStringPref(key, fallback) {
      const entry = store.get(key);
      return entry?.type === 3 ? entry.value : fallback;
    },
    setBoolPref(key, value) {
      store.set(key, { type: 1, value });
    },
    setIntPref(key, value) {
      store.set(key, { type: 2, value });
    },
    setStringPref(key, value) {
      store.set(key, { type: 3, value: String(value) });
    },
    clearUserPref(key) {
      store.delete(key);
    },
    addObserver() {},
    removeObserver() {},
  };
  return { prefs, store };
}

globalThis.Services = createServices();
globalThis.window = {};
globalThis.__browseBotClientCalls = [];

const providerNames = [
  "pollinations",
  "claude",
  "gemini",
  "grok",
  "mistral",
  "ollama",
  "openai",
  "perplexity",
  "cerebras",
  "deepseek",
  "openrouter",
  "custom",
];
const stubs = new Map([
  ["/findbar-ai.uc.js", "export const browseBotFindbar = { findbar: null };"],
  [
    "/client.js",
    `export async function generateText(options) {
  globalThis.__browseBotClientCalls.push({ method: "generateText", options });
  return { text: "done", response: { messages: [] } };
}
export function streamText(options) {
  globalThis.__browseBotClientCalls.push({ method: "streamText", options });
  return { text: Promise.resolve("done"), textStream: (async function* () { yield "done"; })() };
}`,
  ],
  [
    "/providers.js",
    providerNames
      .map((name) => `export const ${name} = { getModelAsync: async () => ({ kind: "openai" }) };`)
      .join("\n"),
  ],
  [
    "/messageManager.js",
    `export const messageManagerAPI = {
  getUrlAndTitle: () => ({ url: "https://current.test", title: "Current page" }),
  getPageTextContent: async () => ({ textContent: "page text", title: "Current page", url: "https://current.test" }),
  getHTMLContent: async () => ({ html: "<p>page</p>" }),
  getYoutubeDescription: async () => ({ description: "" }),
  getYoutubeTranscript: async () => ({ text: "" }),
  currentUrlIsYouTubeVideo: () => false,
};`,
  ],
  [
    "/build-tools.js",
    `export const BUILD_NO_CONFIRM = new Set();
export const buildTools = {};
export async function getBuildSystemPrompt() { return "Build system prompt"; }`,
  ],
  ["/build-preview.js", "export function getStagedJS() { return \"\"; }"],
  [
    "/sine-mods.js",
    `export async function getInstalledMods() { return {}; }
export function isBrowseBotAuthor() { return false; }
export function isUnsafeJSAllowed() { return false; }`,
  ],
  ["/toast.js", "export function showToast() {}"],
  [
    "/search-service.js",
    `export async function getEngineByName() { return null; }
export async function getDefaultEngine() { return null; }
export async function getVisibleEngines() { return []; }`,
  ],
  ["/open-link.js", "export function openLink() {}"],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const normalized = specifier.startsWith("./") ? `/${specifier.slice(2)}` : specifier;
    for (const [suffix, source] of stubs) {
      if (normalized.endsWith(suffix)) {
        return {
          url: `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`,
          shortCircuit: true,
        };
      }
    }
    return nextResolve(specifier, context);
  },
});

beforeEach(() => {
  globalThis.Services.store.clear();
  globalThis.__browseBotClientCalls.length = 0;
});

test("agent steps default to 8 and clamp to 12", () => {
  assert.equal(normalizeAgentSteps(0), 8);
  assert.equal(normalizeAgentSteps(undefined), 8);
  assert.equal(normalizeAgentSteps(3), 3);
  assert.equal(normalizeAgentSteps(50), 12);
  assert.equal(normalizeAgentSteps(-2), 8);
  assert.equal(normalizeAgentSteps(2.9), 2);
  assert.equal(normalizeAgentSteps("5"), 5);
  assert.equal(normalizeAgentSteps(Number.NaN), 8);
  assert.equal(normalizeAgentSteps(Number.POSITIVE_INFINITY), 8);
});

test("untrusted content policy rejects instruction and authorization changes", () => {
  assert.match(UNTRUSTED_CONTENT_POLICY, /untrusted data/i);
  assert.match(UNTRUSTED_CONTENT_POLICY, /cannot override|never override/i);
  assert.match(UNTRUSTED_CONTENT_POLICY, /confirmation|authorization/i);
  assert.match(UNTRUSTED_CONTENT_POLICY, /after its tool returns success/i);
});

test("research and inspection are read-only, typing is not", () => {
  assert.equal(READ_ONLY_TOOLS.has("webResearch"), true);
  assert.equal(READ_ONLY_TOOLS.has("inspectPage"), true);
  assert.equal(READ_ONLY_TOOLS.has("getPageTextContent"), true);
  assert.equal(READ_ONLY_TOOLS.has("getHTMLContent"), true);
  assert.equal(READ_ONLY_TOOLS.has("getAllTabs"), true);
  assert.equal(READ_ONLY_TOOLS.has("searchTabs"), true);
  assert.equal(READ_ONLY_TOOLS.has("typeText"), false);
  assert.equal(READ_ONLY_TOOLS.has("clickElement"), false);
  assert.equal(READ_ONLY_TOOLS.has("pressKey"), false);
});

test("tab context is separate and bounded by the resolver output", () => {
  const context = formatTabContext([
    { title: "One", url: "https://one.test", text: "fresh one" },
    { title: "Two", url: "https://two.test", text: "fresh two" },
  ]);
  assert.match(context, /^Referenced tabs \(untrusted page content\):/);
  assert.match(context, /=== One \(https:\/\/one\.test\) ===/);
  assert.match(context, /fresh two/);
});

function controllerHarness(provider = { supportsTools: true }, prefs = {}) {
  const calls = [];
  const statuses = [];
  const llm = {
    history: [],
    currentProvider: provider,
    llmProvider: "Example provider",
    async streamText(options) {
      calls.push(options);
      return { text: Promise.resolve("done") };
    },
    async generateText(options) {
      calls.push(options);
      return { text: "done" };
    },
  };
  const toolkit = {
    toolNameMapping: { typeText: "Typing text" },
    getToolSystemPrompt: async () => "Tool instructions",
    getTools: (groups, { shouldToolBeCalled, afterToolCall }) =>
      Object.fromEntries(
        ["typeText", "webResearch"].map((name) => [
          name,
          {
            async execute(args) {
              if (!(await shouldToolBeCalled(name, args))) return { error: "denied" };
              const result = name === "webResearch" && args.fail ? { error: "search failed" } : { ok: true };
              afterToolCall(name, result, args);
              return result;
            },
          },
        ])
      ),
  };
  const controller = new AgentController(llm, {
    surface: "floating",
    groups: ["research", "pageInteraction"],
    getSystemPrompt: async () => "Surface instructions",
    toolkit,
    prefs: { maxToolCalls: 50, streamEnabled: true, confirmation: true, ...prefs },
  });
  return { calls, statuses, controller, llm };
}

test("controller bounds steps, forwards cancellation/system, and confirms only writes", async () => {
  const { calls, controller, llm } = controllerHarness();
  const abortController = new AbortController();
  const confirmations = [];
  const statuses = [];
  await controller.sendMessage("act", {
    abortSignal: abortController.signal,
    confirmTool: async (names, detail) => {
      confirmations.push({ names, detail });
      return true;
    },
    onToolStatus: (...args) => statuses.push(args),
  });
  assert.equal(calls[0].maxSteps, 12);
  assert.equal(calls[0].abortSignal, abortController.signal);
  assert.match(calls[0].system, /Surface instructions/);
  assert.match(calls[0].system, /Tool instructions/);
  assert.match(calls[0].system, /untrusted data/i);
  await calls[0].tools.typeText.execute({ selector: "#q", text: "secret" });
  await calls[0].tools.webResearch.execute({ query: "Zen" });
  assert.equal(confirmations.length, 1);
  assert.deepEqual(confirmations[0].names, ["Typing text"]);
  assert.equal(confirmations[0].detail.toolName, "typeText");
  assert.equal(llm.history.length, 0);
  assert.deepEqual(statuses.map((entry) => [entry[0], entry[1]]), [
    ["typeText", "loading"],
    ["typeText", "success"],
    ["webResearch", "loading"],
    ["webResearch", "success"],
  ]);
});

test("controller attaches one hidden tab-context message and honors non-streaming", async () => {
  const { calls, controller, llm } = controllerHarness({ supportsTools: true }, { streamEnabled: false });
  await controller.sendMessage("act", {
    refs: [{ title: "One", url: "https://one.test", text: "fresh one" }],
  });
  assert.equal(calls[0].prompt, "act");
  assert.equal(llm.history.length, 1);
  assert.equal(llm.history[0].role, "user");
  assert.equal(llm.history[0].tabContext, true);
  assert.match(llm.history[0].content, /^Referenced tabs \(untrusted page content\):/);
});

test("floating agent keeps page context separate from user prompt and tab context", async () => {
  const calls = [];
  const llm = {
    history: [{ role: "user", content: "current page", pageContext: true }],
    currentProvider: {},
    llmProvider: "fake",
    streamText: async (options) => {
      calls.push(options);
      return { textStream: [] };
    },
  };
  const controller = new AgentController(llm, {
    surface: "floating",
    groups: [],
    getSystemPrompt: () => "floating",
    toolkit: { getTools: () => ({}), getToolSystemPrompt: () => "" },
    prefs: { maxToolCalls: 0, streamEnabled: true, confirmation: true },
  });
  await controller.sendMessage("compare One", {
    refs: [{ title: "One", url: "https://one.test", text: "fresh" }],
  });
  assert.equal(llm.history[0].pageContext, true);
  assert.equal(llm.history[1].tabContext, true);
  assert.equal(calls[0].prompt, "compare One");
  assert.equal(calls[0].maxSteps, 8);
});

test("controller reports declined writes and tool errors without confirmation when disabled", async () => {
  const declined = controllerHarness();
  const statuses = [];
  await declined.controller.sendMessage("act", {
    confirmTool: async () => false,
    onToolStatus: (...args) => statuses.push(args),
  });
  const result = await declined.calls[0].tools.typeText.execute({ text: "secret" });
  assert.equal(result.error, "denied");
  assert.deepEqual(statuses.map((entry) => [entry[0], entry[1], entry[2]]), [
    ["typeText", "loading", null],
    ["typeText", "declined", "User declined"],
  ]);

  const noConfirm = controllerHarness({ supportsTools: true }, { confirmation: false });
  let confirmations = 0;
  await noConfirm.controller.sendMessage("act", {
    confirmTool: async () => {
      confirmations += 1;
      return true;
    },
  });
  await noConfirm.calls[0].tools.typeText.execute({ text: "secret" });
  assert.equal(confirmations, 0);

  const errors = controllerHarness();
  const errorStatuses = [];
  await errors.controller.sendMessage("act", { onToolStatus: (...args) => errorStatuses.push(args) });
  await errors.calls[0].tools.webResearch.execute({ query: "Zen", fail: true });
  assert.deepEqual(errorStatuses.at(-1).slice(0, 3), ["webResearch", "error", "search failed"]);
});

test("unsupported providers and model capability rejections produce setup guidance", async () => {
  const { controller } = controllerHarness({ supportsTools: false });
  await assert.rejects(controller.sendMessage("act"), /Example provider.*does not support agent tools/);
  const rejection = Object.assign(new Error("Model does not support tools"), {
    code: "UNSUPPORTED_OPERATION",
  });
  const classified = agentCapabilityError(rejection, "Example provider");
  assert.match(classified.message, /Example provider.*does not support agent tools with the selected model/);
  assert.equal(classified.cause, rejection);
  assert.equal(agentCapabilityError(new Error("network offline"), "Example provider"), null);
  assert.match(
    agentCapabilityError(new Error("function calling is not supported"), "Example provider").message,
    /Choose a tool-capable provider\/model/
  );

  const rejecting = controllerHarness();
  rejecting.llm.streamText = async () => {
    throw rejection;
  };
  await assert.rejects(rejecting.controller.sendMessage("act"), /does not support agent tools with the selected model/);
  const network = controllerHarness();
  network.llm.streamText = async () => {
    throw new Error("network offline");
  };
  await assert.rejects(network.controller.sendMessage("act"), /network offline/);
});

test("LLM generateText and streamText accept an optional system override", async () => {
  const { LLM } = await import("../../findbar-ai/llm/index.js");
  const llm = new LLM();
  await llm.generateText({ prompt: "hi", system: "Custom system" });
  assert.equal(globalThis.__browseBotClientCalls.at(-1).options.system, "Custom system");
  await llm.generateText({ prompt: "hi" });
  assert.equal(globalThis.__browseBotClientCalls.at(-1).options.system, "");
  await llm.streamText({ prompt: "hi", system: "Stream system" });
  assert.equal(globalThis.__browseBotClientCalls.at(-1).options.system, "Stream system");
  await llm.streamText({ prompt: "hi" });
  assert.equal(globalThis.__browseBotClientCalls.at(-1).options.system, "");
});

test("tool wrappers return declined and failed results to the model but rethrow aborts", async () => {
  const { getTools } = await import("../../findbar-ai/llm/tools.js");
  const statuses = [];
  const tools = getTools(["research", "pageInteraction"], {
    shouldToolBeCalled: async (name) => name !== "typeText",
    afterToolCall: (name, result) => statuses.push([name, result?.error ? "error" : "success", result?.error]),
  });

  const page = await tools.getPageTextContent.execute({});
  assert.equal(page.textContent, "page text");
  assert.deepEqual(statuses.at(-1), ["getPageTextContent", "success", undefined]);

  const failed = await tools.webResearch.execute({ query: "" });
  assert.match(failed.error, /non-empty search query/);
  assert.deepEqual(statuses.at(-1), ["webResearch", "error", failed.error]);

  const denied = await tools.typeText.execute({ selector: "#q", text: "secret" });
  assert.match(denied.error, /denied by user/);

  const abortController = new AbortController();
  abortController.abort();
  await assert.rejects(tools.webResearch.execute({ query: "Zen" }, { signal: abortController.signal }), {
    name: "AbortError",
  });
});

test("Library Agent delegates to the shared controller without duplicate tab context", async () => {
  PREFS.setPref(PREFS.LIBRARY_MODE, "agent");
  PREFS.setPref(PREFS.MAX_TOOL_CALLS, 50);
  const { BrowseBotLibraryLLM } = await import("../../findbar-ai/library/library-llm.js");
  const llm = new BrowseBotLibraryLLM();
  await llm.sendMessage("act", {
    refs: [{ title: "One", url: "https://one.test", text: "fresh one" }],
  });
  const options = globalThis.__browseBotClientCalls.at(-1).options;
  assert.equal(options.maxSteps, 12);
  assert.match(options.system, /AGENTIC MODE ENABLED/);
  assert.match(options.system, /untrusted data/i);
  assert.match(options.system, /Available Tools/);
  assert.ok(options.tools.webResearch);
  assert.ok(options.tools.typeText);
  assert.equal(options.tools.search, undefined);
  assert.equal(llm.history.length, 2);
  assert.equal(llm.history[0].tabContext, true);
  assert.match(llm.history[0].content, /^Referenced tabs \(untrusted page content\):/);
  assert.equal(llm.history[1].content, "act");
});

test("Library Chat remains tool-free while keeping referenced tab context", async () => {
  PREFS.setPref(PREFS.LIBRARY_MODE, "chat");
  const { BrowseBotLibraryLLM } = await import("../../findbar-ai/library/library-llm.js");
  const llm = new BrowseBotLibraryLLM();
  await llm.sendMessage("hello", {
    refs: [{ title: "One", url: "https://one.test", text: "fresh one" }],
  });
  const options = globalThis.__browseBotClientCalls.at(-1).options;
  assert.equal(options.tools, undefined);
  assert.match(options.system, /Chat Mode/);
  assert.equal(llm.history.length, 2);
  assert.equal(llm.history[0].tabContext, true);
  assert.equal(llm.history[1].content, "hello");
});

test("floating LLM delegates to the shared controller with page context and Markdown citations", async () => {
  PREFS.setPref(PREFS.CITATIONS_ENABLED, true);
  PREFS.setPref(PREFS.STREAM_ENABLED, true);
  PREFS.setPref(PREFS.MAX_TOOL_CALLS, 8);
  const { browseBotFindbarLLM } = await import("../../findbar-ai/llm/index.js");
  browseBotFindbarLLM.clearData();
  const statuses = [];
  await browseBotFindbarLLM.sendMessage("compare One", {
    refs: [{ title: "One", url: "https://one.test", text: "fresh one" }],
    confirmTool: async () => true,
    onToolStatus: (...args) => statuses.push(args),
  });
  const call = globalThis.__browseBotClientCalls.at(-1);
  // The JSON-only citation branch is gone from the floating send path: a
  // streaming agent run is used even with citations enabled.
  assert.equal(call.method, "streamText");
  const options = call.options;
  assert.equal(options.maxSteps, 8);
  assert.ok(options.tools.webResearch);
  assert.ok(options.tools.typeText);
  assert.match(options.system, /Markdown/);
  assert.doesNotMatch(options.system, /single, valid JSON object/);
  assert.match(options.system, /untrusted data/i);
  assert.doesNotMatch(options.system, /use the BrowseBot Library instead/i);
  const history = browseBotFindbarLLM.getHistory();
  assert.equal(history[0].pageContext, true);
  assert.equal(history[1].tabContext, true);
  assert.equal(history[2].content, "compare One");

  // Backward compatibility: a bare AbortSignal second argument still cancels.
  browseBotFindbarLLM.clearData();
  const abortController = new AbortController();
  await browseBotFindbarLLM.sendMessage("plain question", abortController.signal);
  const plain = globalThis.__browseBotClientCalls.at(-1).options;
  assert.equal(plain.abortSignal, abortController.signal);
  assert.equal(browseBotFindbarLLM.getHistory()[0].pageContext, true);

  // Floating history is session-only: it is never pushed into a findbar object.
  const source = fs.readFileSync(new URL("../../findbar-ai/llm/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /browseBotFindbar\.findbar\.history/);
});

test("agent step preference defaults to 8 and migrates unlimited or oversized values once", () => {
  assert.equal(PREFS.defaultValues[PREFS.MAX_TOOL_CALLS], 8);
  for (const [initial, expected] of [
    [0, 8],
    [20, 12],
    [50, 12],
    [1, 1],
    [5, 5],
    [12, 12],
  ]) {
    globalThis.Services.store.clear();
    PREFS.setPref(PREFS.MAX_TOOL_CALLS, initial);
    PREFS.setInitialPrefs();
    assert.equal(PREFS.getPref(PREFS.MAX_TOOL_CALLS), expected);
    PREFS.setInitialPrefs();
    assert.equal(PREFS.getPref(PREFS.MAX_TOOL_CALLS), expected);
  }
  globalThis.Services.store.clear();
  PREFS.setInitialPrefs();
  assert.equal(PREFS.getPref(PREFS.MAX_TOOL_CALLS), 8);
});

test("Sine preferences expose bounded agent tool steps without unlimited options", () => {
  const preferences = JSON.parse(
    fs.readFileSync(new URL("../../findbar-ai/preferences.json", import.meta.url), "utf8")
  );
  const setting = preferences.find(
    (entry) => entry.property === "extension.browse-bot.library-ai.max-tool-calls"
  );
  assert.equal(setting.label, "Agent Max Tool Steps");
  assert.equal(setting.defaultValue, 8);
  assert.deepEqual(setting.options.map((option) => option.value), [1, 2, 3, 5, 8, 10, 12]);
  assert.doesNotMatch(setting.description, /unlimited/i);
});
