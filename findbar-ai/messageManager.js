import { PREFS } from "./utils/prefs.js";

export function pageInteractionLabelFor(element) {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const ariaLabel = clean(element.getAttribute("aria-label"));
  if (ariaLabel) return ariaLabel;
  const associated = clean(
    Array.from(element.labels || [])
      .map((label) => {
        const clone = label.cloneNode(true);
        clone.querySelectorAll("input, textarea, select, [contenteditable]").forEach((editable) => {
          editable.remove();
        });
        return clone.textContent;
      })
      .join(" ")
  );
  if (associated) return associated;
  const tag = String(element.tagName || "").toLowerCase();
  const editable = element.isContentEditable || ["input", "textarea", "select"].includes(tag);
  const text = editable ? "" : clean(element.textContent);
  if (text) return text;
  const name = clean(element.getAttribute("name"));
  if (name) return name;
  return clean(element.getAttribute("placeholder"));
}

export function pageInteractionIsEnabled(element) {
  return !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true";
}

export function dispatchPageKey(content, target, key, { form, submit, deleteBackward, moveFocus }) {
  target.focus();
  const eventInit = { key, code: key, bubbles: true, cancelable: true };
  const keydown = new content.KeyboardEvent("keydown", eventInit);
  let cancelled = !target.dispatchEvent(keydown);
  if (!cancelled && key === "Enter") {
    const keypress = new content.KeyboardEvent("keypress", eventInit);
    cancelled = !target.dispatchEvent(keypress);
  }

  let deleted = false;
  let submitted = false;
  let focusMoved = false;
  if (!cancelled && key === "Backspace") {
    const deletion = deleteBackward(target);
    cancelled = deletion.cancelled;
    deleted = deletion.deleted;
  }
  if (!cancelled && key === "Tab") focusMoved = moveFocus(target, keydown.shiftKey);
  if (!cancelled && key === "Enter" && submit === true) {
    form.requestSubmit();
    submitted = true;
  }

  const keyupTarget = focusMoved ? content.document.activeElement || target : target;
  const keyup = new content.KeyboardEvent("keyup", eventInit);
  keyupTarget.dispatchEvent(keyup);
  return { key, cancelled, deleted, focusMoved, submitted };
}

async function frameScript({ labelFor, isEnabled, dispatchKey }) {
  const getUrlAndTitle = () => {
    return {
      url: content.location.href,
      title: content.document.title,
    };
  };

  const extractSearchResults = () => {
    const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
    return Array.from(
      content.document.querySelectorAll("a:has(h3), .b_algo h2 a, .result__a"),
      (anchor) => {
        const container = anchor.closest("li.b_algo, .result, .g, .MjjYud, article");
        const snippet = container?.querySelector(
          ".b_caption p, .result__snippet, .VwiC3b, [data-sncf]"
        );
        return {
          title: clean(anchor.querySelector("h3, h2")?.textContent || anchor.textContent),
          url: anchor.href || anchor.getAttribute("href") || "",
          snippet: clean(snippet?.textContent || container?.textContent),
        };
      }
    );
  };

  const extractRelevantContent = () => {
    const clonedBody = content.document.body.cloneNode(true);
    const elementsToRemove = clonedBody.querySelectorAll(
      "script, style, meta, noscript, iframe, svg, canvas, img, video, audio, object, embed, applet, link, head"
    );
    elementsToRemove.forEach((el) => el.remove());
    return clonedBody.innerHTML;
  };

  const extractTextContent = (trimWhiteSpace = true) => {
    const clonedBody = content.document.body.cloneNode(true);
    const elementsToRemove = clonedBody.querySelectorAll(
      "script, style, meta, noscript, iframe, svg, canvas, input, textarea, select, img, video, audio, object, embed, applet, form, button, link, head"
    );
    elementsToRemove.forEach((el) => el.remove());

    clonedBody.querySelectorAll("br").forEach((br) => {
      br.replaceWith("\n");
    });

    const blockSelector =
      "p, div, li, h1, h2, h3, h4, h5, h6, tr, article, section, header, footer, aside, main, blockquote, pre";
    clonedBody.querySelectorAll(blockSelector).forEach((el) => {
      el.append("\n");
    });

    const textContent = clonedBody.textContent;

    if (trimWhiteSpace) {
      return textContent.replace(/\s+/g, " ").trim();
    }

    return textContent
      .replace(/[ \t\r\f\v]+/g, " ")
      .replace(/ ?\n ?/g, "\n")
      .replace(/\n+/g, "\n")
      .trim();
  };

  async function getYouTubeTranscript() {
    const win = content;
    const doc = content.document;

    async function ensureBodyAvailable() {
      if (doc.body) return;
      await new Promise((resolve) => {
        const check = () => {
          if (doc.body) resolve();
          else win.setTimeout(check, 50);
        };
        check();
      });
    }

    function waitForSelectorWithObserver(selector, timeout = 5000) {
      return new Promise((resolve, reject) => {
        ensureBodyAvailable()
          .then(() => {
            const el = doc.querySelector(selector);
            if (el) return resolve(el);

            const observer = new win.MutationObserver(() => {
              const el = doc.querySelector(selector);
              if (el) {
                observer.disconnect();
                resolve(el);
              }
            });

            observer.observe(doc.body, {
              childList: true,
              subtree: true,
            });

            win.setTimeout(() => {
              observer.disconnect();
              reject(new Error(`Timeout waiting for ${selector}`));
            }, timeout);
          })
          .catch((e) => {
            reject(new Error(`waitForSelectorWithObserver failed: ${e.message}`));
          });
      });
    }

    const segmentSelector =
      "transcript-segment-view-model, ytd-transcript-segment-renderer .segment-text";
    const buttons = Array.from(doc.querySelectorAll('button[aria-label="Show transcript"]'));
    const button = buttons.find((b) => b.offsetParent !== null) || buttons[0];
    if (button) {
      try {
        button.click();
      } catch {}
    } else if (
      !doc.querySelector("ytd-transcript-renderer") &&
      !doc.querySelector(segmentSelector)
    ) {
      throw new Error('"Show transcript" button not found. Transcript may not be available.');
    }

    await waitForSelectorWithObserver(segmentSelector, 8000);

    const parseTranscriptSegments = () => {
      const modern = Array.from(doc.querySelectorAll("transcript-segment-view-model"))
        .map((seg) => {
          const time =
            seg.querySelector(".ytwTranscriptSegmentViewModelTimestamp")?.textContent.trim() || "";
          const text =
            seg.querySelector('span[role="text"]')?.textContent.trim().replace(/\s+/g, " ") || "";
          if (!text) return "";
          return time ? `[${time}] ${text}` : text;
        })
        .filter(Boolean)
        .join("\n");
      if (modern) return modern;
      return Array.from(doc.querySelectorAll("ytd-transcript-segment-renderer"))
        .map((row) => {
          const text = row.querySelector(".segment-text")?.textContent.trim() || "";
          const time = row.querySelector(".segment-timestamp")?.textContent.trim() || "";
          if (!text) return "";
          return time ? `[${time}] ${text}` : text;
        })
        .filter(Boolean)
        .join("\n");
    };
    const transcript = parseTranscriptSegments();
    if (!transcript) throw new Error("Transcript segments found, but all are empty.");
    return transcript;
  }

  const getYoutubeDescription = async () => {
    const descriptionContainer = content.document.querySelector("#description-inline-expander");
    if (descriptionContainer) {
      const expandButton =
        descriptionContainer.querySelector("#expand") ||
        descriptionContainer.querySelector("#expand-button") ||
        descriptionContainer.querySelector("tp-yt-paper-button#more");
      // Check if button is visible, as it's hidden when expanded
      if (expandButton && expandButton.offsetParent !== null) {
        expandButton.click();
        await new Promise((resolve) => content.setTimeout(resolve, 0));
      }
    }

    const selectors = [
      "#description-inline-expander .yt-core-attributed-string",
      "#description-inline-expander yt-attributed-string",
      "#description-item .yt-core-attributed-string",
      "#description-item yt-attributed-string",
      "#description .content",
      ".ytd-expandable-video-description-body-renderer .yt-core-attributed-string",
      "ytd-expander#description yt-attributed-string",
    ];
    for (const selector of selectors) {
      const text = content.document.querySelector(selector)?.textContent.trim();
      if (text) return text;
    }
    throw new Error(
      "No YouTube description found. This page may not be a YouTube video, or the description is empty."
    );
  };

  const interactiveSelector =
    'a[href], button, input, textarea, select, [role="button"], [contenteditable="true"]';

  const isVisible = (element) => {
    if (!element?.isConnected || element.getClientRects().length === 0) return false;
    const style = content.getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  };

  const requiredElement = (selector) => {
    const element = content.document.querySelector(selector);
    if (!element) throw new Error(`Element with selector "${selector}" not found.`);
    return element;
  };

  const validateActionElement = (element) => {
    if (!isVisible(element)) throw new Error("The target element is not visible.");
    if (!isEnabled(element)) throw new Error("The target element is disabled.");
  };

  const uniqueIdSelector = (element) => {
    if (!element?.id) return null;
    const selector = `#${content.CSS.escape(element.id)}`;
    return content.document.querySelectorAll(selector).length === 1 ? selector : null;
  };

  const nthOfType = (element) => {
    const tag = element.tagName.toLowerCase();
    const parent = element.parentElement;
    if (!parent) return tag;
    const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
    return `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`;
  };

  const selectorFor = (element) => {
    const direct = uniqueIdSelector(element);
    if (direct) return direct;

    let ancestor = element.parentElement;
    let ancestorSelector = null;
    while (ancestor) {
      ancestorSelector = uniqueIdSelector(ancestor);
      if (ancestorSelector) break;
      ancestor = ancestor.parentElement;
    }

    const parts = [];
    let current = element;
    while (current && current !== ancestor) {
      parts.unshift(nthOfType(current));
      current = current.parentElement;
    }
    const selector = `${ancestorSelector ? `${ancestorSelector} > ` : ""}${parts.join(" > ")}`;
    if (content.document.querySelectorAll(selector).length === 1) return selector;
    throw new Error("Could not generate a unique selector for an interactive element.");
  };

  const inspectionEntry = (element) => ({
    selector: selectorFor(element),
    tag: element.tagName.toLowerCase(),
    type: String(element.type || ""),
    label: labelFor(element).slice(0, 200),
    contentEditable: element.isContentEditable === true,
  });

  const visibleInteractiveElements = (root = content.document) =>
    Array.from(root.querySelectorAll(interactiveSelector)).filter(
      (element) => isVisible(element) && isEnabled(element)
    );

  const nativeValueAccess = (element, isTextArea) => {
    const prototype = isTextArea
      ? content.HTMLTextAreaElement.prototype
      : content.HTMLInputElement.prototype;
    const direct = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (direct) return { setter: direct, target: element };

    const wrapped = element.wrappedJSObject;
    let wrappedPrototype = wrapped ? Object.getPrototypeOf(wrapped) : null;
    while (wrappedPrototype) {
      const setter = Object.getOwnPropertyDescriptor(wrappedPrototype, "value")?.set;
      if (setter) return { setter, target: wrapped };
      wrappedPrototype = Object.getPrototypeOf(wrappedPrototype);
    }
    throw new Error("Native input value setter is unavailable.");
  };

  const setNativeValue = (element, value, isTextArea) => {
    const { setter, target } = nativeValueAccess(element, isTextArea);
    setter.call(target, value);
  };

  const supportsBackwardDeletion = (element) => {
    if (!isEnabled(element) || element.readOnly) return false;
    if (element.isContentEditable || element instanceof content.HTMLTextAreaElement) return true;
    if (!(element instanceof content.HTMLInputElement)) return false;
    return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(
      String(element.type || "").toLowerCase()
    );
  };

  const deleteBackward = (element) => {
    if (!supportsBackwardDeletion(element)) return { cancelled: false, deleted: false };
    const before = new content.InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: null,
      inputType: "deleteContentBackward",
    });
    if (!element.dispatchEvent(before)) return { cancelled: true, deleted: false };

    if (element.isContentEditable) {
      const deleted = content.document.execCommand("delete", false);
      return { cancelled: false, deleted };
    }

    const isTextArea = element instanceof content.HTMLTextAreaElement;
    const value = String(element.value);
    let start;
    let end;
    try {
      start = element.selectionStart;
      end = element.selectionEnd;
    } catch {}
    if (typeof start !== "number" || typeof end !== "number") {
      start = value.length;
      end = value.length;
    }
    const deleteStart = start === end ? Math.max(0, start - 1) : start;
    if (deleteStart === end) return { cancelled: false, deleted: false };
    setNativeValue(element, `${value.slice(0, deleteStart)}${value.slice(end)}`, isTextArea);
    try {
      element.setSelectionRange(deleteStart, deleteStart);
    } catch {}
    element.dispatchEvent(new content.Event("input", { bubbles: true }));
    return { cancelled: false, deleted: true };
  };

  const moveFocus = (target, backwards) => {
    const elements = visibleInteractiveElements();
    if (!elements.length) return false;
    const index = elements.indexOf(target);
    const delta = backwards ? -1 : 1;
    const nextIndex = index < 0 ? (backwards ? elements.length - 1 : 0) : (index + delta + elements.length) % elements.length;
    const next = elements[nextIndex];
    if (!next || next === target) return false;
    next.focus();
    return content.document.activeElement === next;
  };

  const handlers = {
    GetPageHTMLContent: () => {
      return {
        content: extractRelevantContent(),
        url: getUrlAndTitle().url,
        title: getUrlAndTitle().title,
      };
    },

    GetSelectedText: () => {
      const selection = content.getSelection();
      return {
        selectedText: selection.toString(),
        hasSelection: !selection.isCollapsed,
        ...getUrlAndTitle(),
      };
    },

    GetPageTextContent: ({ trimWhiteSpace }) => {
      return {
        textContent: extractTextContent(trimWhiteSpace),
        ...getUrlAndTitle(),
      };
    },

    ExtractSearchResults: () => extractSearchResults(),

    InspectInteractiveElements: ({ selector }) => {
      let root = content.document;
      if (selector) {
        root = requiredElement(selector);
      }
      const candidates = [];
      if (root !== content.document && root.matches(interactiveSelector)) candidates.push(root);
      candidates.push(...root.querySelectorAll(interactiveSelector));
      const elements = [];
      for (const element of candidates) {
        if (elements.length >= 50) break;
        if (isVisible(element) && isEnabled(element)) elements.push(inspectionEntry(element));
      }
      return { elements };
    },

    ClickElement: ({ selector, submit }) => {
      const element = requiredElement(selector);
      validateActionElement(element);
      const tag = element.tagName.toLowerCase();
      const type = String(element.type || "").toLowerCase();
      const isSubmitControl =
        (tag === "button" && type === "submit") ||
        (tag === "input" && ["submit", "image"].includes(type));
      if (isSubmitControl && submit !== true) {
        throw new Error("Clicking this submit control requires explicit submit=true.");
      }

      let submissionBlocked = false;
      const preventSubmission = (event) => {
        submissionBlocked = true;
        event.preventDefault();
      };
      if (submit !== true) content.document.addEventListener("submit", preventSubmission, true);
      try {
        element.click();
      } finally {
        if (submit !== true) {
          content.document.removeEventListener("submit", preventSubmission, true);
        }
      }
      return {
        tag,
        type,
        submitted: isSubmitControl && submit === true,
        submissionBlocked,
      };
    },

    TypeText: ({ selector, text, clear }) => {
      const element = requiredElement(selector);
      element.focus();
      const isInput = element instanceof content.HTMLInputElement;
      const isTextArea = element instanceof content.HTMLTextAreaElement;
      const isEditable = element.isContentEditable;
      if (!isInput && !isTextArea && !isEditable) {
        throw new Error("typeText requires an input, textarea, or contenteditable element.");
      }
      validateActionElement(element);
      if (element.readOnly) throw new Error("The target element is read-only.");
      const value = String(text);
      const before = new content.InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: clear ? "insertReplacementText" : "insertText",
      });
      if (!element.dispatchEvent(before)) return { cancelled: true, length: 0 };
      if (isEditable) {
        const selection = content.getSelection();
        const range = content.document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
        if (clear) content.document.execCommand("delete", false);
        selection.collapseToEnd();
        if (!content.document.execCommand("insertText", false, value)) {
          throw new Error("The page did not allow text insertion.");
        }
      } else {
        setNativeValue(element, clear ? value : `${element.value}${value}`, isTextArea);
        element.dispatchEvent(new content.Event("input", { bubbles: true }));
      }
      element.dispatchEvent(new content.Event("change", { bubbles: true }));
      return { cancelled: false, length: value.length };
    },

    PressKey: ({ selector, key, submit }) => {
      if (!["Enter", "Tab", "Escape", "Backspace"].includes(key)) {
        throw new Error("Unsupported key. Use Enter, Tab, Escape, or Backspace.");
      }
      const target = selector
        ? requiredElement(selector)
        : content.document.activeElement || content.document.body || content.document.documentElement;
      if (!target) throw new Error("No page element is available to receive the key press.");
      if (selector) validateActionElement(target);
      const form = key === "Enter" && submit === true ? target.form || target.closest?.("form") : null;
      if (key === "Enter" && submit === true) {
        if (!form || typeof form.requestSubmit !== "function") {
          throw new Error("Enter submission requires an element associated with a submittable form.");
        }
      }

      return dispatchKey(content, target, key, {
        form,
        submit,
        deleteBackward,
        moveFocus,
      });
    },

    FillForm: ({ selector, value }) => {
      const element = content.document.querySelector(selector);
      if (!element) {
        throw new Error(`Element with selector "${selector}" not found.`);
      }
      if (!("value" in element)) {
        throw new Error(
          `Element with selector "${selector}" is not an input element (<${element.tagName.toLowerCase()}>). Use a selector for an input, textarea, or select element.`
        );
      }
      try {
        element.focus();
      } catch {}
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { result: "Filled the target element.", length: String(value).length };
    },

    SeekVideo: ({ seconds }) => {
      const video = content.document.querySelector("video");
      if (!video) {
        throw new Error("No video element found on this page.");
      }
      video.currentTime = Math.max(0, Number(seconds) || 0);
      video.scrollIntoView({ block: "center" });
      return { result: `Seeked to ${seconds}s.` };
    },

    GetYoutubeTranscript: async () => {
      const transcript = await getYouTubeTranscript();
      return { transcript };
    },

    GetYoutubeDescription: async () => {
      const description = await getYoutubeDescription();
      return { description };
    },
  };

  addMessageListener("FindbarAI:Command", async function (msg) {
    const cmd = msg.data.command;
    const data = msg.data.data || {};
    const requestId = msg.data.requestId;
    try {
      const result = await handlers[cmd](data);
      sendAsyncMessage("FindbarAI:Result", { command: cmd, requestId, result });
    } catch (e) {
      sendAsyncMessage("FindbarAI:Result", {
        command: cmd,
        requestId,
        result: { error: e.message },
      });
    }
  });
}

const frameScriptText = `(${frameScript})({
  labelFor: ${pageInteractionLabelFor},
  isEnabled: ${pageInteractionIsEnabled},
  dispatchKey: ${dispatchPageKey},
});`;
const frameScriptURL =
  "data:application/javascript;charset=utf-8," + encodeURIComponent(frameScriptText);

const ensureFrameScript = (browser) => {
  if (!browser?.messageManager || browser._findbarAIInjected) return;
  browser.messageManager.loadFrameScript(frameScriptURL, false);
  browser._findbarAIInjected = true;
};

let requestCounter = 0;

function isYouTubeWatchUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(String(url).trim());
    const host = u.hostname
      .replace(/^www\./, "")
      .replace(/^m\./, "")
      .replace(/^music\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0].length > 0;
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      if (u.pathname === "/watch") return !!u.searchParams.get("v");
      return /^\/(embed|shorts|live|v)\/[^/?]+/.test(u.pathname);
    }
  } catch {
    return false;
  }
  return false;
}

// Tool executors prepend the LLM's args object, so find opts by shape instead of position.
function pickOpts(...args) {
  for (const a of args) {
    if (a && typeof a === "object" && ("signal" in a || "timeout" in a)) return a;
  }
  return undefined;
}

const sendToBrowser = (browser, cmd, data = {}, opts = {}) => {
  const { timeout = 15000, signal } = opts || {};
  ensureFrameScript(browser);
  const mm = browser.messageManager;
  if (!mm) return Promise.reject(new Error("No message manager available."));
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  const requestId = `${Date.now().toString(36)}-${requestCounter++}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      mm.removeMessageListener("FindbarAI:Result", listener);
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(val);
    };
    const onAbort = () => settle(reject, new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      settle(
        reject,
        new Error(
          `Timed out waiting for a page response (${cmd}, ${timeout}ms). The tab may be unloaded, still loading, or on a page that blocks content scripts.`
        )
      );
    }, timeout);
    const listener = (msg) => {
      const d = msg.data || {};
      // Older injected scripts omit requestId; accept those by command.
      if (d.requestId !== undefined && d.requestId !== requestId) return;
      if (d.command !== cmd) return;
      if (d.result && d.result.error) {
        settle(reject, new Error(d.result.error));
      } else {
        settle(resolve, d.result);
      }
    };
    mm.addMessageListener("FindbarAI:Result", listener);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      mm.sendAsyncMessage("FindbarAI:Command", { command: cmd, data, requestId });
    } catch (e) {
      settle(reject, e);
    }
  });
};

export const messageManagerAPI = {
  send(cmd, data = {}, opts) {
    if (!gBrowser || !gBrowser.selectedBrowser) {
      PREFS.debugError("No message manager available.");
      return Promise.reject(new Error("No message manager available."));
    }
    return sendToBrowser(gBrowser.selectedBrowser, cmd, data, opts);
  },

  async getPageTextContentForTab(tab, trimWhiteSpace = true, opts) {
    const browser = tab?.linkedBrowser;
    if (!browser?.messageManager) return null;
    try {
      const result = await sendToBrowser(browser, "GetPageTextContent", { trimWhiteSpace }, opts);
      return {
        textContent: result?.textContent || "",
        url: result?.url || browser.currentURI?.spec || "",
        title: result?.title || tab.label || "",
      };
    } catch (error) {
      PREFS.debugError("Failed to get page text content for tab:", error);
      return null;
    }
  },

  async extractSearchResultsForTab(tab, opts) {
    const browser = tab?.linkedBrowser;
    if (!browser?.messageManager || tab.closing || !tab.isConnected) {
      return { error: "Search tab is closed or no longer connected." };
    }
    return sendToBrowser(browser, "ExtractSearchResults", {}, opts);
  },

  getUrlAndTitle() {
    return {
      url: gBrowser.currentURI.spec,
      title: gBrowser.selectedBrowser.contentTitle,
    };
  },

  async getHTMLContent(...rest) {
    return this.send("GetPageHTMLContent", {}, pickOpts(...rest)).catch((error) => {
      PREFS.debugError("Failed to get page HTML content:", error);
      return {};
    });
  },

  async getSelectedText(...rest) {
    return this.send("GetSelectedText", {}, pickOpts(...rest))
      .then((result) => {
        if (!result || !result.hasSelection) {
          return this.getUrlAndTitle();
        }
        return result;
      })
      .catch((error) => {
        PREFS.debugError("Failed to get selected text:", error);
        return this.getUrlAndTitle();
      });
  },

  async getPageTextContent(trimWhiteSpace = true, ...rest) {
    return this.send(
      "GetPageTextContent",
      { trimWhiteSpace },
      pickOpts(trimWhiteSpace, ...rest)
    ).catch((error) => {
      PREFS.debugError("Failed to get page text content:", error);
      return this.getUrlAndTitle();
    });
  },

  async inspectPageForTab(browser, selector, opts) {
    if (!browser?.messageManager) throw new Error("The page tab is closed or no longer connected.");
    return sendToBrowser(browser, "InspectInteractiveElements", { selector }, opts);
  },

  async clickElementForTab(browser, selector, submit = false, opts) {
    if (!browser?.messageManager) throw new Error("The page tab is closed or no longer connected.");
    return sendToBrowser(browser, "ClickElement", { selector, submit: submit === true }, opts);
  },

  async typeTextForTab(browser, selector, text, clear = false, opts) {
    if (!browser?.messageManager) throw new Error("The page tab is closed or no longer connected.");
    return sendToBrowser(browser, "TypeText", { selector, text, clear: clear === true }, opts);
  },

  async pressKeyForTab(browser, key, selector, submit = false, opts) {
    if (!browser?.messageManager) throw new Error("The page tab is closed or no longer connected.");
    return sendToBrowser(
      browser,
      "PressKey",
      { key, selector, submit: key === "Enter" && submit === true },
      opts
    );
  },

  async clickElement(selector, ...rest) {
    return this.send("ClickElement", { selector }, pickOpts(selector, ...rest)).catch((error) => {
      PREFS.debugError(`Failed to click element with selector "${selector}":`, error);
      return { error: `Failed to click element with selector "${selector}".` };
    });
  },

  async fillForm(selector, value, ...rest) {
    return this.send("FillForm", { selector, value }, pickOpts(selector, value, ...rest)).catch(
      (error) => {
        PREFS.debugError(`Failed to fill form with selector "${selector}":`, error);
        return { error: `Failed to fill form with selector "${selector}".` };
      }
    );
  },

  async seekVideo(seconds) {
    return this.send("SeekVideo", { seconds }).catch((error) => {
      PREFS.debugError(`Failed to seek video to ${seconds}s:`, error);
      return { error: `Failed to seek video.` };
    });
  },

  currentUrlIsYouTubeVideo() {
    try {
      return isYouTubeWatchUrl(this.getUrlAndTitle().url);
    } catch {
      return false;
    }
  },

  async getYoutubeTranscript(...rest) {
    if (!this.currentUrlIsYouTubeVideo()) {
      return {
        error:
          "Current page is not a YouTube video. Only use this tool on youtube.com/watch pages.",
      };
    }
    return this.send("GetYoutubeTranscript", {}, { timeout: 25000, ...pickOpts(...rest) }).catch(
      (error) => {
        PREFS.debugError("Failed to get youtube transcript:", error);
        return { error: `Failed to get youtube transcript: ${error.message}` };
      }
    );
  },

  async getYoutubeDescription(...rest) {
    if (!this.currentUrlIsYouTubeVideo()) {
      return {
        error:
          "Current page is not a YouTube video. Only use this tool on youtube.com/watch pages.",
      };
    }
    return this.send("GetYoutubeDescription", {}, pickOpts(...rest)).catch((error) => {
      PREFS.debugError("Failed to get youtube description:", error);
      return { error: `Failed to get youtube description: ${error.message}` };
    });
  },
};
