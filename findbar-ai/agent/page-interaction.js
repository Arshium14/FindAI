import { messageManagerAPI } from "../messageManager.js";
import { obj, str } from "../llm/schema.js";

const TAB_ID_DESCRIPTION =
  "Optional tab session ID from getAllTabs/searchTabs or a referenced tab. Omit for the selected tab.";
const SUBMIT_INSTRUCTION =
  "Set submit=true only when the user explicitly requested form submission.";

function optionalBoolean(description) {
  return { type: "boolean", description, optional: true };
}

function descriptor(description, parameters, execute) {
  return { description, parameters: obj(parameters), execute };
}

function unavailableTabError() {
  return new Error("The page tab is closed or no longer connected.");
}

export function resolvePageTab(tabId, { selectedTab, resolveTab } = {}) {
  if (tabId === undefined || tabId === null) {
    if (!selectedTab?.isConnected || selectedTab.closing) throw unavailableTabError();
    return selectedTab;
  }
  const tab = resolveTab?.(tabId);
  if (!tab?.isConnected || tab.closing) throw unavailableTabError();
  return tab;
}

export function normalizeKey(key) {
  const normalized = typeof key === "string" ? key.toLowerCase() : "";
  const supported = {
    enter: "Enter",
    tab: "Tab",
    escape: "Escape",
    backspace: "Backspace",
  };
  if (!Object.hasOwn(supported, normalized)) {
    throw new Error(`Unsupported key "${String(key)}". Use Enter, Tab, Escape, or Backspace.`);
  }
  return supported[normalized];
}

function cleanInspectionElement(element) {
  return {
    selector: String(element?.selector || ""),
    tag: String(element?.tag || ""),
    type: String(element?.type || ""),
    label: String(element?.label || ""),
    contentEditable: element?.contentEditable === true,
  };
}

export function redactedPageResult(action, tab, detail = {}) {
  const tabId = tab?.id === undefined || tab?.id === null ? null : String(tab.id);
  const tabTitle = String(tab?.label || "");
  if (action === "inspectPage") {
    const elements = Array.isArray(detail.elements)
      ? detail.elements.slice(0, 50).map(cleanInspectionElement)
      : [];
    return {
      tabId,
      tabTitle,
      result: `Found ${elements.length} visible interactive element${elements.length === 1 ? "" : "s"}.`,
      elements,
    };
  }
  if (action === "typeText") {
    const length = Number.isInteger(detail.length) && detail.length >= 0 ? detail.length : 0;
    return {
      tabId,
      tabTitle,
      result: `Typed ${length} characters into the target element.`,
      length,
    };
  }
  if (action === "clickElement") {
    return {
      tabId,
      tabTitle,
      result: "Clicked the target element.",
      tag: String(detail.tag || ""),
      type: String(detail.type || ""),
      submitted: detail.submitted === true,
    };
  }
  if (action === "pressKey") {
    const key = normalizeKey(detail.key);
    return {
      tabId,
      tabTitle,
      result: `Pressed ${key}.`,
      key,
      cancelled: detail.cancelled === true,
      submitted: detail.submitted === true,
      focusMoved: detail.focusMoved === true,
    };
  }
  return { tabId, tabTitle, result: "Page action completed." };
}

function requiredSelector(args, toolName) {
  if (typeof args?.selector !== "string" || !args.selector.trim()) {
    throw new Error(`${toolName} requires a selector.`);
  }
  return args.selector;
}

function safeError(error, typedText) {
  let message = String(error?.message || error || "Page interaction failed.");
  if (typeof typedText === "string" && typedText) {
    message = message.split(typedText).join("[redacted]");
    const escaped = JSON.stringify(typedText).slice(1, -1);
    if (escaped) message = message.split(escaped).join("[redacted]");
  }
  return { error: message };
}

export function createPageInteractionTools(resolveTab) {
  const selectedTab = () => globalThis.gBrowser?.selectedTab;
  const run = async (action, args, opts, send) => {
    try {
      const tab = resolvePageTab(args?.tabId, { selectedTab: selectedTab(), resolveTab });
      const browser = tab.linkedBrowser;
      if (!browser?.messageManager) throw unavailableTabError();
      const detail = await send(browser);
      if (action === "typeText" && detail?.cancelled) {
        throw new Error("The page cancelled typing; no text was inserted.");
      }
      return redactedPageResult(action, tab, detail);
    } catch (error) {
      return safeError(error, action === "typeText" ? args?.text : undefined);
    }
  };

  return {
    inspectPage: descriptor(
      "Read-only inspection of up to 50 visible enabled interactive elements on the selected or referenced tab. Returns selectors, tags, types, labels, and contenteditable state, never form values. Optionally scope inspection with selector.",
      {
        tabId: str(TAB_ID_DESCRIPTION, true),
        selector: str("Optional CSS selector for an element whose interactive subtree should be inspected.", true),
      },
      async (args = {}, opts) =>
        run("inspectPage", args, opts, (browser) =>
          messageManagerAPI.inspectPageForTab(browser, args.selector, opts)
        )
    ),
    clickElement: descriptor(
      `Clicks a visible enabled element on the selected or referenced tab. Submit controls require submit=true; ordinary clicks never intentionally submit a form. ${SUBMIT_INSTRUCTION}`,
      {
        tabId: str(TAB_ID_DESCRIPTION, true),
        selector: str("The CSS selector of the element to click."),
        submit: optionalBoolean(`Allow a submit control to submit its form. ${SUBMIT_INSTRUCTION}`),
      },
      async (args = {}, opts) =>
        run("clickElement", args, opts, (browser) =>
          messageManagerAPI.clickElementForTab(
            browser,
            requiredSelector(args, "clickElement"),
            args.submit === true,
            opts
          )
        )
    ),
    typeText: descriptor(
      "Types text into an input, textarea, or contenteditable element on the selected or referenced tab using native setters and input events. Set clear=true to replace existing content. Results contain only the character count; typed text is never returned.",
      {
        tabId: str(TAB_ID_DESCRIPTION, true),
        selector: str("The CSS selector of the input, textarea, or contenteditable element."),
        text: str("The text to insert. This sensitive value is not included in results."),
        clear: optionalBoolean("Replace existing content instead of appending."),
      },
      async (args = {}, opts) =>
        run("typeText", args, opts, (browser) => {
          const selector = requiredSelector(args, "typeText");
          if (typeof args.text !== "string") throw new Error("typeText requires text.");
          return messageManagerAPI.typeTextForTab(
            browser,
            selector,
            args.text,
            args.clear === true,
            opts
          );
        })
    ),
    pressKey: descriptor(
      `Presses Enter, Tab, Escape, or Backspace on the selected or referenced tab, optionally focusing selector first. Enter submits only with submit=true. ${SUBMIT_INSTRUCTION}`,
      {
        tabId: str(TAB_ID_DESCRIPTION, true),
        key: str("The key to press: Enter, Tab, Escape, or Backspace."),
        selector: str("Optional CSS selector of the element to focus before pressing the key.", true),
        submit: optionalBoolean(`Allow Enter to request form submission. ${SUBMIT_INSTRUCTION}`),
      },
      async (args = {}, opts) =>
        run("pressKey", args, opts, (browser) => {
          const key = normalizeKey(args.key);
          return messageManagerAPI.pressKeyForTab(
            browser,
            key,
            args.selector,
            key === "Enter" && args.submit === true,
            opts
          );
        })
    ),
  };
}
