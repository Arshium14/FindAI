// Persistent browser-chrome floating panel for BrowseBot.
//
// One #browse-bot-panel is appended to #main-window and stays connected across
// tab switches, workspace switches, and native findbar open/close. It owns the
// chat run view and AbortController on `this`, never on a native findbar or a
// tab, so hiding the panel or switching tabs never aborts a streaming run.
//
// Arc 2.0 invariants (Task 8):
// - The panel stays position:fixed at the BrowseBot stacking level defined by
//   #browse-bot-panel CSS. This module never applies transforms to .browserStack
//   or any Arc element and never writes native findbar geometry.
// - Geometry is derived exclusively through Task 6 (cornerRect) and driven by
//   Task 7 (PanelGestures + PanelLayoutCoordinator). Preference writes happen
//   once at gesture end, never from observers or pointer-move callbacks.
//
// Shared agent wiring (Task 9):
// - @mentions resolve through the shared TabReferenceController, so a mention
//   re-reads the referenced tab at send time (fresh content, never a cache).
// - Every run goes through browseBotFindbarLLM.sendMessage(prompt, { refs,
//   abortSignal, confirmTool, onToolStatus }), which delegates to the shared
//   AgentController: the same toolkit, step bound, confirmation policy, and
//   untrusted-content rules as the Library Agent surface.
// - Tool activity is rendered from the shared ToolActivity model (already
//   redacted through safeArgsPreview/scrubbing) into [data-tool-activity] as one
//   compact <details> per run, never as extra assistant bubbles.
// - A confirmation stays pending across hide()/show() and tab switches; only the
//   user's Decline, "Don't ask again", or Stop resolves it.

import { parseElement, escapeXmlAttribute, xulImage } from "../utils/parse.js";
import { icons } from "../utils/icon.js";
import { showToast } from "../utils/toast.js";
import { PREFS } from "./utils/prefs.js";
import { browseBotFindbarLLM } from "./llm/index.js";
import { timestampToSeconds } from "./llm/youtube.js";
import { toolVerbs } from "./llm/tools.js";
import { messageManagerAPI } from "./messageManager.js";
import { agentCapabilityError } from "./agent/controller.js";
import {
  TabReferenceController,
  insertReferenceChips,
  tokenBeforeCaret,
} from "./agent/tab-references.js";
import { ToolActivity } from "./agent/tool-activity.js";
import { parseMD } from "./utils/markdown.js";
import {
  renderStreamText,
  extractErrorText,
  isProviderBalanceExhausted,
  setStreamingControls,
  attachMessageActions,
  attachChatMessageHandlers,
} from "./utils/chat.js";
import { cornerRect } from "./panel/geometry.js";
import { PanelGestures } from "./panel/gestures.js";
import { PanelLayoutCoordinator } from "./panel/layout-coordinator.js";
import { SettingsModal } from "./settings.js";

// Matches the min-width/min-height in #browse-bot-panel CSS.
const PANEL_MIN_SIZE = { width: 320, height: 240 };
const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];
const DEFAULT_SIZE = { width: 500, height: 600 };

// Chrome skin icons used for tool status. Hardcoded constants, never untrusted.
const TOOL_STATUS_ICONS = {
  loading: "chrome://global/skin/icons/loading.svg",
  success: "chrome://global/skin/icons/check.svg",
  error: "chrome://global/skin/icons/error.svg",
  declined: "chrome://global/skin/icons/blocked.svg",
};

function toolStatusIcon(status) {
  return TOOL_STATUS_ICONS[status] || "";
}

// Mirrors the Library helper: an animated SVG while loading, a XUL <image>
// (which chrome:// icons require) for every terminal state.
function setStatusIcon(wrap, status) {
  if (!wrap) return;
  if (status === "loading") {
    wrap.innerHTML = icons.toolLoading;
    return;
  }
  let img = wrap.querySelector("image");
  if (!img) {
    img = xulImage("");
    wrap.replaceChildren(img);
  }
  img.setAttribute("src", toolStatusIcon(status));
}

function shortText(value, limit = 60) {
  const t = String(value ?? "").replace(/\s+/g, " ").trim();
  return t.length > limit ? `${t.slice(0, limit - 1)}…` : t;
}

function fmtSecs(ms) {
  return `${(Number(ms) / 1000).toFixed(1)}s`;
}

// Keys that describe a tool's target. Deliberately excludes the redacted keys
// (text/value/typedText/content) so typed values never reach a label, preview,
// log, or error.
const TOOL_TARGET_KEYS = ["searchTerm", "query", "link", "url", "selector", "name", "title"];

function toolTarget(toolName, args) {
  if (!args || typeof args !== "object") return "";
  const keys = [...TOOL_TARGET_KEYS];
  if (toolName === "readMod" || toolName === "updateModFile") keys.push("modId");
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return shortText(value.trim(), 40);
  }
  return "";
}

function toolVerb(toolName, status, args) {
  const [loading, done] = toolVerbs[toolName] || [toolName, toolName];
  if (status === "declined") {
    return `Declined - ${loading.charAt(0).toLowerCase()}${loading.slice(1)}`;
  }
  const base = status === "loading" ? loading : done;
  const target = toolTarget(toolName, args);
  return target ? `${base} · ${target}` : base;
}

// Research previews list what a tool returned, never the page text itself:
// source.text is untrusted content and would also blow past the row budget.
function researchPreview(result) {
  if (!result || typeof result !== "object") return "";
  const results = Array.isArray(result.results) ? result.results : [];
  const sources = Array.isArray(result.sources) ? result.sources : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const lines = [
    `${results.length} result${results.length === 1 ? "" : "s"} · ${sources.length} source${
      sources.length === 1 ? "" : "s"
    } read`,
  ];
  for (const source of sources) {
    const label = shortText(source?.title || source?.url || "(untitled)", 60);
    if (source?.error) lines.push(`! ${label}: ${shortText(source.error, 90)}`);
    else lines.push(`- ${label} ${shortText(source?.url || "", 90)}`.trimEnd());
  }
  for (const warning of warnings) lines.push(`! ${shortText(warning, 140)}`);
  return lines.join("\n");
}

// Context messages the shared controller injects are never chat bubbles and must
// never shift a regenerate ordinal.
function isContextMessage(message) {
  if (!message) return false;
  if (message.pageContext || message.tabContext) return true;
  return message.role === "user" && String(message.content || "").startsWith("Referenced tabs");
}

export class BrowseBotFloatingPanel {
  constructor() {
    this.panel = null;
    this.gestures = null;
    this.layout = null;
    // Set by the facade on TabSelect; the panel itself is tab-independent.
    this.targetTab = null;
    this.abortController = null;
    this._streaming = false;
    // Current run view kept on `this` so hide()/show() reuse the same nodes.
    this._runView = null;
    this._composerSend = null;
    this._highlightTimeout = null;
    // Scroll state captured at hide() and restored at show().
    this._savedScrollTop = 0;
    this._savedFollowing = true;
    // Shared @-mention state (Task 9).
    this.tabReferences = new TabReferenceController();
    this._refPopup = { items: [], index: 0, token: null };
    // Confirmations survive hide()/show() and tab switches; Stop declines them.
    this._pendingConfirms = new Set();
  }

  // --- Lifecycle -----------------------------------------------------------

  init() {
    if (this.panel?.isConnected) return;
    // A previous panel may still exist but be disconnected (facade teardown
    // paths). Detach its controllers first so no ResizeObserver/MutationObserver
    // is left watching a dead node.
    this.gestures?.detach();
    this.layout?.stop();
    this.panel = parseElement(`
      <div id="browse-bot-panel" class="browse-bot-panel" hidden>
        <div class="browse-bot-panel-header" data-drag-handle>
          <span class="browse-bot-panel-title">BrowseBot</span>
          <div class="browse-bot-panel-actions">
            <button class="zenux-icon-btn" data-action="new" title="New chat"></button>
            <button class="zenux-icon-btn" data-action="settings" title="BrowseBot settings"></button>
            <button class="zenux-icon-btn" data-action="close" title="Hide panel"></button>
          </div>
        </div>
        <div class="browse-bot-tool-activity" data-tool-activity hidden></div>
        <div class="browse-bot-messages" data-messages></div>
        <div class="browse-bot-reference-chips" data-reference-chips></div>
        <div class="browse-bot-composer">
          <div class="bb-ref-popup" data-ref-popup hidden></div>
          <textarea class="zenux-input" data-prompt rows="1" placeholder="Ask BrowseBot… (@ to reference tabs)"></textarea>
          <button class="zenux-btn-primary" data-action="send">Send</button>
          <button class="zenux-btn-danger" data-action="stop" hidden>Stop</button>
        </div>
        ${["n", "s", "e", "w", "ne", "nw", "se", "sw"]
          .map((edge) => `<div class="browse-bot-resize-handle" data-resize="${edge}"></div>`)
          .join("")}
      </div>
    `);
    document.getElementById("main-window").appendChild(this.panel);
    this.bindComposer();
    this.gestures = new PanelGestures(this.panel, this.gestureCallbacks());
    this.layout = new PanelLayoutCoordinator(this.panel, this.layoutCallbacks());
    this.gestures.attach();
    this.layout.start();
    this.applySavedDimensions();
    // Render any in-memory history once; the idempotent guard above prevents
    // duplication on repeated init() calls.
    this.renderHistory();
  }

  // Sole lifecycle method that aborts on teardown, detaches controllers and
  // observers, and removes the panel. hide() never does any of this.
  destroy() {
    this.abortController?.abort();
    this.abortController = null;
    this._declinePendingConfirms();
    this._streaming = false;
    this._runView = null;
    if (this._highlightTimeout) {
      clearTimeout(this._highlightTimeout);
      this._highlightTimeout = null;
    }
    // detach() ends any in-flight gesture cleanly so persistence is not lost.
    this.gestures?.detach();
    this.layout?.stop();
    this.gestures = null;
    this.layout = null;
    this.panel?.remove();
    this.panel = null;
  }

  get expanded() {
    return !!this.panel && !this.panel.hidden;
  }
  set expanded(value) {
    if (value) this.show();
    else this.hide();
  }

  get enabled() {
    return PREFS.enabled;
  }
  set enabled(value) {
    if (typeof value === "boolean") PREFS.enabled = value;
  }

  get streaming() {
    return this._streaming;
  }

  // expanded only toggles panel.hidden, schedules layout, and restores scroll
  // / focus. It never aborts a run, never removes the run view, and never
  // resolves a pending confirmation.
  show() {
    if (!this.panel) return false;
    if (this.panel.hidden) {
      this.panel.hidden = false;
      const messagesEl = this._messagesEl();
      if (messagesEl) {
        messagesEl.scrollTop = this._savedFollowing
          ? messagesEl.scrollHeight
          : this._savedScrollTop;
      }
    }
    this.layout?.schedule("show");
    this.focusPrompt();
    return true;
  }

  hide() {
    if (!this.panel || this.panel.hidden) return false;
    const messagesEl = this._messagesEl();
    if (messagesEl) {
      this._savedScrollTop = messagesEl.scrollTop;
      this._savedFollowing = this._atBottom(messagesEl);
    }
    this._hideRefPopup();
    this.panel.hidden = true;
    this.layout?.schedule("hide");
    return true;
  }

  toggle() {
    if (this.expanded) this.hide();
    else this.show();
  }

  // Explicit New chat only: abort the current run first, then clear history,
  // messages, activity, references, and draft. Dimensions/position survive.
  clear() {
    this.abortController?.abort();
    this.abortController = null;
    this._declinePendingConfirms();
    this._setStreaming(false);
    browseBotFindbarLLM.clearData();
    this._runView = null;
    const messagesEl = this._messagesEl();
    if (messagesEl) messagesEl.replaceChildren();
    const activityEl = this._activityEl();
    if (activityEl) {
      activityEl.replaceChildren();
      activityEl.hidden = true;
    }
    this.tabReferences.clear();
    this._hideRefPopup();
    const chipsEl = this.panel?.querySelector("[data-reference-chips]");
    if (chipsEl) chipsEl.replaceChildren();
    const promptInput = this._promptEl();
    if (promptInput) {
      promptInput.value = "";
      promptInput.style.height = "";
    }
    this._savedScrollTop = 0;
    this._savedFollowing = true;
  }

  stop() {
    // Stop is the only non-user-decline path that resolves a confirmation, so an
    // aborted run cannot leave a tool waiting forever.
    this._declinePendingConfirms();
    this.abortController?.abort();
  }

  focusPrompt() {
    const promptInput = this._promptEl();
    if (promptInput) setTimeout(() => promptInput.focus(), 10);
  }

  setPromptText(text) {
    const promptInput = this._promptEl();
    if (!promptInput) return;
    promptInput.value = text || "";
    this.tabReferences.text = promptInput.value;
    this._autoGrowPrompt();
  }

  // Send whatever is currently in the composer (the Send button path). Used by
  // the native Ask AI button so the copied query is consumed like a typed one.
  sendFromComposer() {
    this._composerSend?.();
  }

  // --- UI wiring -----------------------------------------------------------

  bindComposer() {
    const panel = this.panel;
    const newBtn = panel.querySelector('[data-action="new"]');
    const settingsBtn = panel.querySelector('[data-action="settings"]');
    const closeBtn = panel.querySelector('[data-action="close"]');

    // Existing chrome skin icons rendered as HTML <img> (same pattern as the
    // Library panel). No new icon dependency.
    const fillIcon = (btn, src, label) => {
      if (!btn) return;
      // src is a hardcoded chrome:// skin constant, never untrusted data.
      btn.replaceChildren(parseElement(`<img src="${src}" width="16" height="16" alt="" />`));
      btn.setAttribute("aria-label", label);
      // Never begin a header drag from an action button.
      btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    };
    fillIcon(newBtn, "chrome://global/skin/icons/delete.svg", "New chat");
    fillIcon(settingsBtn, "chrome://global/skin/icons/settings.svg", "BrowseBot settings");
    fillIcon(closeBtn, "chrome://global/skin/icons/close.svg", "Hide panel");

    newBtn?.addEventListener("click", () => this.clear());
    settingsBtn?.addEventListener("click", () => SettingsModal.show("general"));
    closeBtn?.addEventListener("click", () => this.hide());

    const promptInput = panel.querySelector("[data-prompt]");
    const sendBtn = panel.querySelector('[data-action="send"]');
    const stopBtn = panel.querySelector('[data-action="stop"]');

    const handleSend = () => {
      if (this._streaming) return;
      const text = promptInput.value.trim();
      if (!text) return;
      this._hideRefPopup();
      this.sendComposerText(text);
    };
    this._composerSend = handleSend;

    sendBtn?.addEventListener("click", handleSend);
    stopBtn?.addEventListener("click", () => this.stop());

    promptInput?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const popup = this._refPopupEl();
        if (popup && !popup.hidden) {
          this._hideRefPopup();
        } else if (promptInput.value || this.tabReferences.pending.length) {
          promptInput.value = "";
          this.tabReferences.clear();
          this._renderRefChips();
        } else {
          this.hide();
        }
        return;
      }
      const popup = this._refPopupEl();
      if (popup && !popup.hidden) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this._moveRefPopup(1);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          this._moveRefPopup(-1);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          this._applyRefPopupItem();
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    promptInput?.addEventListener("input", () => {
      if (this.tabReferences.sync(promptInput.value)) this._renderRefChips();
      this._autoGrowPrompt();
      this._refreshRefPopup();
    });
    promptInput?.addEventListener("click", () => this._refreshRefPopup());
    promptInput?.addEventListener("blur", () => setTimeout(() => this._hideRefPopup(), 150));

    const messagesEl = panel.querySelector("[data-messages]");
    if (messagesEl) {
      attachChatMessageHandlers(messagesEl, {
        onCitation: (citation, event) => this._handleCitation(citation, event),
      });
    }
  }

  _promptEl() {
    return this.panel?.querySelector("[data-prompt]") ?? null;
  }

  _activityEl() {
    return this.panel?.querySelector("[data-tool-activity]") ?? null;
  }

  _refPopupEl() {
    return this.panel?.querySelector("[data-ref-popup]") ?? null;
  }

  _autoGrowPrompt() {
    const input = this._promptEl();
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  // --- @-mention popup and reference chips (shared TabReferenceController) ---

  _hideRefPopup() {
    const popup = this._refPopupEl();
    if (!popup) return;
    popup.hidden = true;
    popup.replaceChildren();
    this._refPopup = { items: [], index: 0, token: null };
  }

  _paintRefPopupActive() {
    const popup = this._refPopupEl();
    if (!popup) return;
    popup.querySelectorAll(".bb-popup-item").forEach((el, i) => {
      el.classList.toggle("is-active", i === this._refPopup.index);
      if (i === this._refPopup.index) el.scrollIntoView({ block: "nearest" });
    });
  }

  _refreshRefPopup() {
    const input = this._promptEl();
    const popup = this._refPopupEl();
    if (!input || !popup) return;
    const caret = input.selectionStart ?? input.value.length;
    const token = tokenBeforeCaret(input.value, caret);
    if (!token) {
      this._hideRefPopup();
      return;
    }
    const items = this.tabReferences.listTabs(token.filter);
    if (items.length === 0) {
      this._hideRefPopup();
      return;
    }
    this._refPopup = { items, index: 0, token };
    popup.replaceChildren();
    items.forEach((item, i) => {
      // Tab titles/URLs are untrusted data: they go through escapeXmlAttribute
      // and are only ever displayed, never interpreted.
      const el = parseElement(
        `<div class="bb-popup-item${i === 0 ? " is-active" : ""}" data-index="${i}">
          ${item.icon ? `<img class="bb-popup-icon" src="${escapeXmlAttribute(item.icon)}" />` : ""}
          <span class="bb-popup-title">${escapeXmlAttribute(item.title)}</span>
          <span class="bb-popup-desc">${escapeXmlAttribute(item.url)}</span>
        </div>`
      );
      const img = el.querySelector(".bb-popup-icon");
      img?.addEventListener("error", () => img.remove());
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this._applyRefPopupItem(i);
      });
      popup.appendChild(el);
    });
    popup.hidden = false;
  }

  _moveRefPopup(delta) {
    const { items } = this._refPopup;
    const popup = this._refPopupEl();
    if (!popup || popup.hidden || items.length === 0) return;
    this._refPopup.index = (this._refPopup.index + delta + items.length) % items.length;
    this._paintRefPopupActive();
  }

  _applyRefPopupItem(index = this._refPopup.index) {
    const input = this._promptEl();
    const { items, token } = this._refPopup;
    const item = items[index];
    if (!input || !item) return false;
    const caret = input.selectionStart ?? input.value.length;
    const caretToken = token || tokenBeforeCaret(input.value, caret);
    if (!caretToken) return false;
    const edit = this.tabReferences.select(item, input.value, caret, caretToken);
    input.value = edit.text;
    try {
      input.setSelectionRange(edit.caret, edit.caret);
    } catch {}
    this._renderRefChips();
    this._autoGrowPrompt();
    this._hideRefPopup();
    input.focus();
    return true;
  }

  _renderRefChips() {
    const chipsEl = this.panel?.querySelector("[data-reference-chips]");
    if (!chipsEl) return;
    this.tabReferences.renderChips(chipsEl, (nextText) => {
      const input = this._promptEl();
      if (!input) return;
      input.value = nextText;
      this._autoGrowPrompt();
      input.focus();
    });
  }

  // Resolve @mentions at send time. The shared controller re-reads each
  // referenced tab, so the content sent is always fresh, and unreadable tabs
  // produce an explicit warning instead of a silent success.
  async sendComposerText(text) {
    const draft = String(text || "").trim();
    if (!draft || this._streaming) return;
    const { prompt, refs, warnings } = await this.tabReferences.resolve(draft, {
      maxChars: PREFS.getPref(PREFS.MAX_CONTEXT_CHARS) || 0,
    });
    if (!prompt.trim()) return;
    for (const warning of warnings) this.addChatMessage({ role: "error", content: warning });
    this.addChatMessage({ role: "user", content: draft, refs });
    const input = this._promptEl();
    if (input) {
      input.value = "";
      input.style.height = "";
    }
    this.tabReferences.clear();
    this._renderRefChips();
    this._hideRefPopup();
    return this.sendMessage(prompt, { refs, showUserMessage: false });
  }

  // --- Tool confirmation ----------------------------------------------------

  // Mirrors the Library dialog contract: returns Promise<boolean>, keeps the
  // element across hide()/show(), and toasts when the panel is not visible. No
  // tool arguments are rendered here, so typed values can never leak into an
  // approval prompt.
  _confirmTool(toolNames, detail = {}) {
    return new Promise((resolve) => {
      const messagesEl = this._messagesEl();
      const names = (Array.isArray(toolNames) ? toolNames : [toolNames])
        .filter(Boolean)
        .join(", ");
      if (!messagesEl) {
        // No surface to ask on: fail closed rather than assume approval.
        resolve(false);
        return;
      }
      const dialog = parseElement(`
        <div class="tool-confirmation-dialog">
          <div class="tool-confirmation-content">
            <p class="tool-confirm-title">Allow BrowseBot to do the following: ${escapeXmlAttribute(
              names
            )}?</p>
            <div class="buttons">
              <button class="not-again zenux-btn-ghost">Don't ask again</button>
              <div class="right-side-buttons">
                <button class="decline-tool zenux-btn-ghost">Decline</button>
                <button class="confirm-tool zenux-btn-primary">Allow</button>
              </div>
            </div>
          </div>
        </div>`);
      const done = (value) => {
        dialog.remove();
        this._pendingConfirms.delete(dialog);
        resolve(value);
      };
      this._pendingConfirms.add(dialog);
      dialog.querySelector(".confirm-tool").addEventListener("click", () => done(true));
      dialog.querySelector(".decline-tool").addEventListener("click", () => done(false));
      dialog.querySelector(".not-again").addEventListener("click", () => {
        PREFS.confirmation = false;
        done(true);
      });
      messagesEl.appendChild(dialog);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      if (!this.expanded) {
        try {
          showToast({
            title: "BrowseBot needs approval",
            description: names,
            preset: 2,
            buttonText: "Review",
            timeout: 15000,
            onClick: () => this.show(),
          });
        } catch {}
      }
    });
  }

  _declinePendingConfirms() {
    for (const dialog of [...this._pendingConfirms]) {
      try {
        dialog.querySelector(".decline-tool")?.click();
      } catch {}
    }
    this._pendingConfirms.clear();
  }

  // --- Tool activity rendering (shared ToolActivity model) ------------------

  _startActivityRun() {
    const container = this._activityEl();
    if (container) {
      container.replaceChildren();
      container.hidden = true;
    }
    return {
      activity: new ToolActivity(),
      box: null,
      rows: null,
      title: null,
      count: 0,
      done: 0,
      start: Date.now(),
      activeRow: null,
      toolEvents: 0,
    };
  }

  // One <details> per run inside [data-tool-activity]. Native collapse keeps the
  // summary/rows markup identical to the Library burst box so both surfaces can
  // share the .bb-tool-run* CSS tokens.
  _buildActivityBox(container) {
    const box = parseElement(`
      <details class="bb-tool-run" data-state="working">
        <summary class="bb-tool-run-header">
          <span class="bb-tool-run-status"></span>
          <span class="bb-tool-run-title">Working…</span>
          <img class="bb-tool-run-chevron" src="chrome://global/skin/icons/arrow-down-12.svg" alt="" />
        </summary>
        <div class="bb-tool-run-rows"></div>
      </details>`);
    setStatusIcon(box.querySelector(".bb-tool-run-status"), "loading");
    container.hidden = false;
    container.replaceChildren(box);
    return {
      box,
      rows: box.querySelector(".bb-tool-run-rows"),
      title: box.querySelector(".bb-tool-run-title"),
    };
  }

  _buildToolRow(entry, args) {
    const row = parseElement(`
      <div class="bb-tool-row" data-status="${entry.status}">
        <span class="bb-tool-row-icon"></span>
        <div class="bb-tool-row-label"></div>
        <span class="bb-tool-row-time"></span>
      </div>`);
    row.querySelector(".bb-tool-row-label").textContent = toolVerb(entry.tool, entry.status, args);
    row.querySelector(".bb-tool-row-time").textContent =
      entry.status === "loading" ? "" : fmtSecs(entry.elapsedMs);
    setStatusIcon(row.querySelector(".bb-tool-row-icon"), entry.status);
    const detail = parseElement(`<div class="bb-tool-row-detail" hidden></div>`);
    row.querySelector(".bb-tool-row-label").addEventListener("click", () => {
      if (!detail.textContent) return;
      detail.hidden = !detail.hidden;
    });
    return { row, detail };
  }

  // Only ever renders text produced by the shared ToolActivity model
  // (safeArgsPreview + scrubbed result snapshot) or the research summary, so
  // typed values never appear in a preview.
  _entryPreview(entry, result) {
    if (entry.error) return `Error: ${entry.error}`;
    if (entry.tool === "webResearch") return researchPreview(result) || entry.resultText;
    return [entry.argsText, entry.resultText].filter(Boolean).join("\n");
  }

  _refreshActivityTitle(run) {
    if (!run?.box || !run.title) return;
    const pending = run.count - run.done;
    run.box.dataset.state = pending > 0 ? "working" : "done";
    setStatusIcon(
      run.box.querySelector(".bb-tool-run-status"),
      pending > 0 ? "loading" : "success"
    );
    const elapsed = ` · ${fmtSecs(Date.now() - run.start)}`;
    if (pending > 0) {
      let current = run.activeRow?.dataset.label;
      if (!current && run.rows) {
        const loading = run.rows.querySelectorAll('.bb-tool-row[data-status="loading"]');
        current = loading.length ? loading[loading.length - 1].dataset.label : null;
      }
      run.title.textContent = `${current || "Working"}…${elapsed}`;
      return;
    }
    run.title.textContent = `Used ${run.count} tool${run.count === 1 ? "" : "s"}${elapsed}`;
  }

  // Same (toolName, status, error, args, result) contract as the Library's
  // updateToolCallUI, fed by the shared AgentController.
  _onToolStatus(run, toolName, status, error = null, args = null, result = null) {
    if (!run) return;
    const entry = run.activity.handle(toolName, status, error, args, result);
    run.toolEvents += 1;
    const container = this._activityEl();
    if (!container) return;
    if (!run.box) {
      const built = this._buildActivityBox(container);
      run.box = built.box;
      run.rows = built.rows;
      run.title = built.title;
    }
    let row = run.rows.querySelector(`.bb-tool-row[data-activity-id="${entry.id}"]`);
    let detail = row?._detail ?? null;
    if (!row) {
      run.count += 1;
      const built = this._buildToolRow(entry, args);
      row = built.row;
      detail = built.detail;
      row.dataset.activityId = entry.id;
      row.dataset.tool = entry.tool;
      row.dataset.label = toolVerb(entry.tool, "loading", args);
      row._detail = detail;
      run.rows.appendChild(row);
      run.rows.appendChild(detail);
      run.activeRow = entry.status === "loading" ? row : null;
    }
    if (status !== "loading") {
      run.done += 1;
      row.querySelector(".bb-tool-row-time").textContent = fmtSecs(entry.elapsedMs);
      run.activeRow = null;
    }
    row.dataset.status = entry.status;
    row.querySelector(".bb-tool-row-label").textContent = toolVerb(entry.tool, entry.status, args);
    setStatusIcon(row.querySelector(".bb-tool-row-icon"), entry.status);
    if (detail) detail.textContent = this._entryPreview(entry, result);
    this._refreshActivityTitle(run);
  }

  // A run that ends while a tool is still loading (Stop, abort, provider error)
  // must never look successful: those rows become explicit errors.
  _finalizeActivity(run) {
    if (!run?.box) return;
    for (const row of run.rows.querySelectorAll('.bb-tool-row[data-status="loading"]')) {
      row.dataset.status = "error";
      setStatusIcon(row.querySelector(".bb-tool-row-icon"), "error");
      const time = row.querySelector(".bb-tool-row-time");
      if (time) time.textContent = "stopped";
      if (row._detail) row._detail.textContent = "Run stopped before this tool reported a result.";
      run.done += 1;
    }
    run.box.dataset.state = "done";
    const unresolved = run.rows.querySelector(
      '.bb-tool-row[data-status="error"], .bb-tool-row[data-status="declined"]'
    );
    setStatusIcon(run.box.querySelector(".bb-tool-run-status"), unresolved ? "error" : "success");
    if (run.title) {
      run.title.textContent = `Used ${run.count} tool${run.count === 1 ? "" : "s"} · ${fmtSecs(
        Date.now() - run.start
      )}`;
    }
    run.activeRow = null;
  }

  // --- Citations ------------------------------------------------------------

  // Markdown links are the only citation shape now. A link is a citation when it
  // carries a #t=mm:ss video fragment or points back at the current page; every
  // other link stays a normal source link that opens in a tab.
  _decorateCitations(root) {
    if (!root || !PREFS.citationsEnabled) return;
    const currentUrl = String(gBrowser?.selectedBrowser?.currentURI?.spec || "");
    const currentBase = currentUrl.split("#")[0];
    for (const anchor of root.querySelectorAll("a[href]")) {
      const href = String(anchor.getAttribute("href") || "");
      const timeMatch = /#t=(\d{1,3}:\d{2}(?::\d{2})?)$/.exec(href);
      if (timeMatch) {
        anchor.classList.add("citation-link");
        anchor.dataset.timestamp = timeMatch[1];
        continue;
      }
      if (currentBase && href.split("#")[0] === currentBase) {
        anchor.classList.add("citation-link");
        anchor.dataset.citationQuote = shortText(anchor.textContent, 300);
      }
    }
  }

  _handleCitation(el, event) {
    // Citations act on the page instead of navigating.
    event?.preventDefault();
    event?.stopPropagation();
    if (!el) return;
    if (el.dataset.timestamp) {
      const seconds = timestampToSeconds(el.dataset.timestamp);
      if (seconds !== null) messageManagerAPI.seekVideo(seconds);
      return;
    }
    // The quote is untrusted page content: pass it to the finder as data only.
    if (el.dataset.citationQuote) this.highlight(el.dataset.citationQuote);
  }

  // Highlight a quote through the content finder without touching the native
  // findbar UI or geometry.
  highlight(word) {
    if (!word) return;
    const finder = gBrowser?.selectedBrowser?.finder;
    if (!finder) return;
    if (this._highlightTimeout) clearTimeout(this._highlightTimeout);
    try {
      finder.fastFind(word, false, false);
      finder.highlight(true);
    } catch {
      return;
    }
    this._highlightTimeout = setTimeout(() => {
      try {
        finder.highlight(false);
      } catch {}
      this._highlightTimeout = null;
    }, 2000);
  }

  // --- Geometry wiring (Tasks 6-7) -----------------------------------------

  _viewport() {
    return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  }

  _savedSize() {
    return {
      width: Number(PREFS.width) || DEFAULT_SIZE.width,
      height: Number(PREFS.height) || DEFAULT_SIZE.height,
    };
  }

  _applyRect(rect) {
    if (!this.panel || !rect) return;
    const style = this.panel.style;
    style.left = `${rect.x}px`;
    style.top = `${rect.y}px`;
    style.width = `${rect.width}px`;
    style.height = `${rect.height}px`;
  }

  applySavedDimensions() {
    if (!this.panel) return;
    this._applyRect(cornerRect(this._savedSize(), PREFS.position, this._viewport()));
  }

  gestureCallbacks() {
    return {
      onDragStart: () => {
        this.layout.activeGesture = true;
      },
      onResizeStart: () => {
        this.layout.activeGesture = true;
      },
      // Geometry is already written by PanelGestures; no preference writes here.
      onChange: () => {},
      onDragEnd: (rect) => {
        this.layout.activeGesture = false;
        this._saveNearestCorner(rect);
        this.layout.schedule("drag-end");
      },
      onResizeEnd: (rect) => {
        this.layout.activeGesture = false;
        if (PREFS.rememberDimensions) {
          PREFS.width = Math.round(rect.width);
          PREFS.height = Math.round(rect.height);
        }
        this.layout.schedule("resize-end");
      },
    };
  }

  layoutCallbacks() {
    return {
      getPreferredRect: () => {
        if (this.panel?.isConnected) {
          const r = this.panel.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          }
        }
        return cornerRect(this._savedSize(), PREFS.position, this._viewport());
      },
      getPreferredCorner: () => PREFS.position,
      getMinSize: () => ({ ...PANEL_MIN_SIZE }),
      onLayout: (rect) => this._applyRect(rect),
    };
  }

  // Choose and save the nearest preferred corner once, at drag end.
  _saveNearestCorner(rect) {
    if (!rect) return;
    const viewport = this._viewport();
    const size = { width: rect.width, height: rect.height };
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    let nearest = PREFS.position;
    let minDistance = Infinity;
    for (const corner of CORNERS) {
      const candidate = cornerRect(size, corner, viewport);
      const dx = candidate.x + candidate.width / 2 - cx;
      const dy = candidate.y + candidate.height / 2 - cy;
      const distance = dx * dx + dy * dy;
      if (distance < minDistance) {
        minDistance = distance;
        nearest = corner;
      }
    }
    if (nearest !== PREFS.position) PREFS.position = nearest;
  }

  // --- Chat rendering / streaming ------------------------------------------

  _messagesEl() {
    return this.panel?.querySelector("[data-messages]") ?? null;
  }

  _atBottom(el) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
  }

  _setStreaming(streaming) {
    this._streaming = streaming;
    if (!this.panel) return;
    const sendBtn = this.panel.querySelector('[data-action="send"]');
    const stopBtn = this.panel.querySelector('[data-action="stop"]');
    setStreamingControls({ sendBtn, stopBtn }, streaming, () => this.focusPrompt());
    if (stopBtn) stopBtn.hidden = !streaming;
  }

  renderHistory() {
    const history = browseBotFindbarLLM.getHistory();
    for (const message of history) {
      if (isContextMessage(message)) continue;
      this.addChatMessage(message);
    }
  }

  async sendMessage(prompt, { refs = [], showUserMessage = true } = {}) {
    if (!prompt || this._streaming) return;

    this.show();
    if (showUserMessage) this.addChatMessage({ role: "user", content: prompt, refs });

    const messagesEl = this._messagesEl();
    const controller = new AbortController();
    this.abortController = controller;
    this._setStreaming(true);
    const run = this._startActivityRun();

    const aiMessageDiv = parseElement(
      `<div class="chat-message chat-message-ai">
        <div class="message-content">
          <div class="markdown-body"></div>
        </div>
      </div>`
    );
    this._runView = aiMessageDiv;
    const contentDiv = aiMessageDiv.querySelector(".markdown-body");
    if (messagesEl) {
      messagesEl.appendChild(aiMessageDiv);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    try {
      const resultPromise = browseBotFindbarLLM.sendMessage(prompt, {
        refs,
        abortSignal: controller.signal,
        confirmTool: (names, detail) => this._confirmTool(names, detail),
        onToolStatus: (...args) => this._onToolStatus(run, ...args),
      });

      if (!PREFS.streamEnabled) {
        const loadingIndicator = this.createLoadingIndicator();
        messagesEl?.appendChild(loadingIndicator);
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;

        try {
          const result = await resultPromise;
          if (loadingIndicator.parentNode) loadingIndicator.remove();
          const text = typeof result?.text === "string" ? result.text : String(result?.text ?? "");
          if (this._isPollinationsBalanceExhausted(text)) {
            this._flagPollinationsKeyPrompt();
            this._renderPollinationsKeyPrompt(contentDiv);
          } else if (text.trim() === "") {
            // A tool-only run is a real result, not an empty bubble.
            if (run.toolEvents > 0) contentDiv.appendChild(parseMD("*(Tool actions performed)*"));
            else aiMessageDiv.remove();
          } else {
            contentDiv.appendChild(parseMD(text));
          }
          this._decorateCitations(contentDiv);
        } finally {
          if (loadingIndicator.parentNode) loadingIndicator.remove();
          if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
        }
      } else {
        const loadingIndicator = this.createLoadingIndicator();
        messagesEl?.appendChild(loadingIndicator);
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;

        const result = await resultPromise;
        let fullText = "";
        try {
          const renderStream = () => {
            const following = this._atBottom(messagesEl);
            renderStreamText(contentDiv, fullText);
            this._decorateCitations(contentDiv);
            if (following && messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
          };
          for await (const delta of result.textStream) {
            if (loadingIndicator.parentNode) loadingIndicator.remove();
            fullText += delta;
            renderStream();
          }
          // The last delta can leave an intermediate state behind (e.g. a
          // fence that only looks unclosed). Settle on the final text so the
          // first view matches the history re-render.
          try {
            const finalText = await result.text;
            if (typeof finalText === "string") fullText = finalText;
          } catch (e) {
            PREFS.debugError("Failed to resolve final stream text:", e.message);
          }
          renderStream();
          if (this._isPollinationsBalanceExhausted(fullText)) {
            this._flagPollinationsKeyPrompt();
            this._renderPollinationsKeyPrompt(contentDiv);
          } else if (fullText.trim() === "") {
            if (run.toolEvents > 0) contentDiv.appendChild(parseMD("*(Tool actions performed)*"));
            else aiMessageDiv.remove();
          }
        } finally {
          if (loadingIndicator.parentNode) loadingIndicator.remove();
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        const reportedError = agentCapabilityError(e, browseBotFindbarLLM.llmProvider) || e;
        PREFS.debugError("Error sending message:", reportedError);
        if (aiMessageDiv) aiMessageDiv.remove();
        const errorText = extractErrorText(reportedError);
        if (this._isPollinationsBalanceExhausted(errorText)) {
          browseBotFindbarLLM.history.push({
            role: "assistant",
            content: "",
            pollinationsKeyPrompt: true,
          });
          this.addChatMessage({ role: "assistant", content: "", pollinationsKeyPrompt: true });
        } else {
          // Provider failure leaves the user's prompt in history and shows an
          // error view whose Retry action calls regenerateFrom.
          this.addChatMessage({ role: "error", content: errorText });
        }
      } else {
        PREFS.debugLog("Streaming aborted by user.");
        if (contentDiv && contentDiv.textContent.trim()) {
          contentDiv.appendChild(parseMD("_Stopped_"));
        } else if (aiMessageDiv) {
          aiMessageDiv.remove();
        }
      }
    } finally {
      this._finalizeActivity(run);
      if (aiMessageDiv.isConnected) {
        attachMessageActions(aiMessageDiv, {
          onRegenerate: (wrap) => this.regenerateFrom(wrap),
        });
      }
      // Only clear streaming controls if the completing controller is still
      // the active one (a newer run or clear() may have replaced it).
      if (this.abortController === controller) {
        this._setStreaming(false);
        this.abortController = null;
      }
      if (this._runView === aiMessageDiv) this._runView = null;
    }
  }

  regenerateFrom(wrap) {
    if (!wrap?.isConnected || this._streaming) return;
    const messagesEl = this._messagesEl();
    if (!messagesEl) return;
    const userWraps = [...messagesEl.querySelectorAll(".chat-message-user")];
    let userWrap = null;
    if (wrap.classList.contains("chat-message-user")) {
      userWrap = wrap;
    } else {
      let prev = wrap.previousElementSibling;
      while (prev) {
        if (prev.classList?.contains("chat-message-user")) {
          userWrap = prev;
          break;
        }
        prev = prev.previousElementSibling;
      }
    }
    if (!userWrap) return;
    const ordinal = userWraps.indexOf(userWrap);
    if (ordinal < 0) return;
    const history = browseBotFindbarLLM.getHistory();
    // Context messages (page text, @mention tab text) never render, so they must
    // not consume a regenerate ordinal.
    const userEntries = history.filter((m) => !isContextMessage(m) && m.role === "user");
    if (ordinal >= userEntries.length) return;
    const target = userEntries[ordinal];
    const prompt = String(target.content || "").trim();
    if (!prompt) return;
    browseBotFindbarLLM.setHistory(history.slice(0, history.indexOf(target)));
    let node = userWrap;
    while (node) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
    this.sendMessage(prompt);
  }

  createLoadingIndicator() {
    return parseElement(
      `<div class="chat-message chat-message-loading"><div class="message-content">${icons.toolLoading}Loading...</div></div>`
    );
  }

  _isPollinationsBalanceExhausted(text) {
    return isProviderBalanceExhausted(browseBotFindbarLLM.currentProvider, text);
  }

  _flagPollinationsKeyPrompt() {
    const history = browseBotFindbarLLM.history;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]?.role === "assistant") {
        history[i].pollinationsKeyPrompt = true;
        break;
      }
    }
  }

  _renderPollinationsKeyPrompt(contentDiv) {
    contentDiv.replaceChildren();
    const provider = browseBotFindbarLLM.currentProvider;
    const keyUrl = provider?.apiKeyUrl || "https://enter.pollinations.ai/keys";
    const promptEl = parseElement(`
      <div class="pollinations-key-prompt">
        <p>Pollinations ran out of free credits for this request (anonymous tier).
          <a href="${escapeXmlAttribute(keyUrl)}">Get a free API key</a>,
          paste it below, and send your message again. The key stays optional.</p>
        <div class="pollinations-key-row">
          <input type="password" class="zenux-input" placeholder="Paste Pollinations API key" />
          <button class="zenux-btn-primary">Save</button>
        </div>
        <span class="key-prompt-status"></span>
      </div>`);
    const input = promptEl.querySelector("input");
    const saveBtn = promptEl.querySelector("button");
    const status = promptEl.querySelector(".key-prompt-status");
    saveBtn.addEventListener("click", async () => {
      const key = input.value.trim();
      if (!key) {
        status.textContent = "Paste your API key first.";
        return;
      }
      saveBtn.disabled = true;
      try {
        await browseBotFindbarLLM.currentProvider.setApiKeyAsync(key);
        input.value = "";
        status.textContent = "Saved. Send your message again to retry with your key.";
      } catch (e) {
        PREFS.debugError("Could not save Pollinations API key:", e);
        status.textContent = "Could not save the key, try again.";
      } finally {
        saveBtn.disabled = false;
      }
    });
    input.addEventListener("keypress", (e) => {
      if (e.key === "Enter") saveBtn.click();
    });
    input.addEventListener("input", () => {
      status.textContent = "";
    });
    contentDiv.appendChild(promptEl);
  }

  addChatMessage(message) {
    const { role, content, refs } = message || {};
    const messagesEl = this._messagesEl();
    if (!messagesEl || content === undefined || content === null) return;

    if (
      message.pollinationsKeyPrompt &&
      browseBotFindbarLLM.currentProvider?.name === "pollinations"
    ) {
      const promptDiv = parseElement(`<div class="chat-message chat-message-ai"></div>`);
      const promptContent = parseElement(`<div class="message-content"></div>`);
      promptDiv.appendChild(promptContent);
      messagesEl.appendChild(promptDiv);
      this._renderPollinationsKeyPrompt(promptContent);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }

    let type;
    switch (role) {
      case "user":
        type = "user";
        break;
      case "assistant":
        type = "ai";
        break;
      case "error":
        type = "error";
        break;
      default:
        return; // Don't display other roles like 'tool'
    }

    const messageDiv = parseElement(`<div class="chat-message chat-message-${type}"></div>`);
    const contentDiv = parseElement(`<div class="message-content"></div>`);

    // One Markdown render path for every role: citations are ordinary Markdown
    // links, so there is no separate answer/citations object shape any more.
    const textContent = typeof content === "string" ? content : (content?.[0]?.text ?? "");
    contentDiv.appendChild(parseMD(textContent));

    messageDiv.appendChild(contentDiv);
    if (type === "ai") this._decorateCitations(contentDiv);
    if (type === "user") insertReferenceChips(contentDiv, refs);
    attachMessageActions(messageDiv, {
      onRegenerate: (wrap) => this.regenerateFrom(wrap),
    });
    if (type === "error") {
      // The regenerate action doubles as Retry on the error view.
      const retryBtn = messageDiv.querySelector(".bb-msg-regen");
      if (retryBtn) {
        retryBtn.setAttribute("title", "Retry");
        retryBtn.setAttribute("aria-label", "Retry");
      }
    }
    messagesEl.appendChild(messageDiv);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}
