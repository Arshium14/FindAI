import { messageManagerAPI } from "../messageManager.js";
import { getDefaultEngine, getEngineByName } from "../../utils/search-service.js";

const MAX_RESULTS = 8;
const MAX_SOURCES = 3;

function boundedLimit(value, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return maximum;
  return Math.max(0, Math.min(maximum, Math.floor(number)));
}

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function waitForTabLoad(tab, signal) {
  throwIfAborted(signal);
  const browser = tab?.linkedBrowser;
  if (!browser) return Promise.reject(new Error("The research tab has no readable browser."));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      browser.removeEventListener("load", onLoad, true);
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onLoad = (event) => {
      if (event.target === browser.contentDocument) settle(resolve);
    };
    const onAbort = () => settle(reject, new DOMException("Aborted", "AbortError"));
    browser.addEventListener("load", onLoad, true);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      settle(reject, new Error("Timed out after 15 seconds while loading a research tab."));
    }, 15000);
    if (browser.contentDocument?.readyState === "complete" && browser.currentURI?.spec !== "about:blank") {
      settle(resolve);
    }
  });
}

function createBrowserIO(signal) {
  const owner = {};
  const marker = Symbol("browseBotResearchOwner");
  const onTabSelect = (event) => {
    const tab = event.target;
    if (tab?.[marker] === owner) delete tab[marker];
  };
  gBrowser.tabContainer.addEventListener("TabSelect", onTabSelect);

  const reused = (tab) => {
    if (!tab || tab[marker] !== owner || !tab.isConnected) return true;
    if (tab === gBrowser.selectedTab) {
      delete tab[marker];
      return true;
    }
    return false;
  };
  const close = async (tab) => {
    if (reused(tab)) return;
    gBrowser.removeTab(tab);
    delete tab[marker];
  };
  const open = async (url, { onOpen } = {}) => {
    throwIfAborted(signal);
    const tab = gBrowser.addTab(url, { inBackground: true, skipAnimation: true });
    tab[marker] = owner;
    onOpen?.(tab);
    await waitForTabLoad(tab, signal);
    throwIfAborted(signal);
    return tab;
  };

  return {
    open,
    async extract(tab, opts) {
      const extracted = await messageManagerAPI.extractSearchResultsForTab(tab, opts);
      if (!Array.isArray(extracted)) {
        throw new Error(extracted?.error || "Search results could not be extracted from this page.");
      }
      return extracted;
    },
    async read(tab, opts) {
      const page = await messageManagerAPI.getPageTextContentForTab(tab, true, opts);
      throwIfAborted(opts?.signal);
      if (!page) {
        throw new Error("The source could not be read; it may be closed, blocked, or require sign-in.");
      }
      return page;
    },
    reused,
    close,
    cleanup() {
      gBrowser.tabContainer.removeEventListener("TabSelect", onTabSelect);
    },
  };
}

export function normalizeSearchResults(items, { maxResults = MAX_RESULTS } = {}) {
  if (!Array.isArray(items)) return [];
  const limit = boundedLimit(maxResults, MAX_RESULTS);
  const results = [];
  const seen = new Set();
  for (const item of items) {
    if (results.length >= limit) break;
    const title = collapseWhitespace(item?.title);
    if (!title || !item?.url) continue;
    try {
      const url = new URL(String(item.url).trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      url.hash = "";
      const normalizedUrl = url.href;
      if (seen.has(normalizedUrl)) continue;
      seen.add(normalizedUrl);
      results.push({
        title,
        url: normalizedUrl,
        snippet: collapseWhitespace(item.snippet),
      });
    } catch {}
  }
  return results;
}

export async function runResearch(
  { query, searchUrl },
  { signal, io, maxResults = MAX_RESULTS, maxSources = MAX_SOURCES }
) {
  const owned = new Set();
  const warnings = [];
  const openOwned = async (url) => {
    throwIfAborted(signal);
    const tab = await io.open(url, { onOpen: (opened) => owned.add(opened) });
    owned.add(tab);
    return tab;
  };
  try {
    const searchTab = await openOwned(searchUrl);
    throwIfAborted(signal);
    const rawResults = await io.extract(searchTab, { signal });
    throwIfAborted(signal);
    const results = normalizeSearchResults(rawResults, { maxResults });
    if (results.length === 0) {
      warnings.push(
        "No accessible search results were extracted; CAPTCHA, sign-in, or unsupported scripting may be blocking results."
      );
    }
    const sources = [];
    const sourceLimit = boundedLimit(maxSources, MAX_SOURCES);
    for (const [index, result] of results.slice(0, sourceLimit).entries()) {
      throwIfAborted(signal);
      const source = { id: index + 1, ...result, text: "", error: null };
      try {
        const sourceTab = await openOwned(result.url);
        throwIfAborted(signal);
        const page = await io.read(sourceTab, { signal });
        throwIfAborted(signal);
        source.title = page.title || result.title;
        source.url = page.url || result.url;
        source.text = String(page.textContent || "").trim();
        if (!source.text) source.error = "No readable source text was available.";
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        source.error = error?.message || String(error);
        warnings.push(`Could not read ${result.url}: ${source.error}`);
      }
      sources.push(source);
    }
    return { query, searchUrl, results, sources, warnings };
  } finally {
    for (const tab of owned) {
      try {
        if (!io.reused(tab)) await io.close(tab);
      } catch {}
    }
    owned.clear();
    try {
      io.cleanup?.();
    } catch {}
  }
}

export async function webResearch(args, opts = {}) {
  const signal = opts?.signal;
  const query = String(args?.query || "").trim();
  if (!query) throw new Error("webResearch requires a non-empty search query.");
  throwIfAborted(signal);

  const engineName = String(args?.engineName || "").trim();
  const engine = engineName ? await getEngineByName(engineName) : await getDefaultEngine();
  throwIfAborted(signal);
  if (!engine) {
    throw new Error(
      engineName
        ? `Search engine "${engineName}" was not found.`
        : "The browser has no default search engine."
    );
  }

  let searchUrl;
  try {
    searchUrl = engine.getSubmission(query)?.uri?.spec;
    const parsed = new URL(searchUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    searchUrl = parsed.href;
  } catch {
    throw new Error("The search engine returned an unreadable HTTP(S) submission URL.");
  }

  const io = createBrowserIO(signal);
  return runResearch(
    { query, searchUrl },
    { signal, io, maxResults: MAX_RESULTS, maxSources: MAX_SOURCES }
  );
}
