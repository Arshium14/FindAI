// Native-findbar facade for the persistent BrowseBot floating panel.
//
// Task 8 replaces the old native-findbar-owned chat (which rebuilt the UI on
// every TabSelect via updateFindbar() and aborted streaming on collapse/close)
// with one persistent #browse-bot-panel owned by BrowseBotFloatingPanel. This
// facade keeps every public call used by index.js, the context menu, and
// settings, delegating to the single panel instance.
//
// Native findbar rules (Task 8):
// - No updateFindbar() on TabSelect; no Ctrl+F replacement.
// - attachAskAI() adds one Ask AI button and retains Alt+Enter in the native
//   find field. It never writes native findbar geometry, moves match elements,
//   overrides matches display, or closes native text search when the panel
//   hides.
// - Ctrl+Shift+F stays the floating toggle (registered in index.js).

import { messageManagerAPI } from "./messageManager.js";
import { PREFS } from "./utils/prefs.js";
import { parseElement } from "../utils/parse.js";
import { SettingsModal } from "./settings.js";
import { addPrefListener, removePrefListener } from "../utils/pref.js";
import { BrowseBotFloatingPanel } from "./floating-panel.js";

PREFS.setInitialPrefs();

export const browseBotFindbar = {
  // The BrowseBotFloatingPanel instance. It owns the DOM panel, gestures,
  // layout coordinator, target tab, run view, and AbortController.
  panel: null,
  _initialized: false,
  aiStatus: {
    citationsEnabled: PREFS.citationsEnabled,
  },

  // Native findbar integration (per-tab findbars are tracked for teardown).
  _attachedFindbars: new Set(),
  _handleInputKeyPress: null,

  // Context menu
  contextMenuItem: null,
  _contextMenuRetryTimer: null,
  _handleContextMenuClick: null,
  _updateContextMenuText: null,

  // Listeners
  onTabSelect: null,
  onFindbarOpen: null,
  onFindbarClose: null,
  _addKeymaps: null,
  _citationsListener: null,
  _contextMenuEnabledListener: null,

  // --- Delegated public surface --------------------------------------------

  get expanded() {
    return this.panel?.expanded ?? false;
  },
  set expanded(value) {
    if (this.panel) this.panel.expanded = value;
  },
  get enabled() {
    return PREFS.enabled;
  },
  set enabled(value) {
    if (typeof value === "boolean") PREFS.enabled = value;
  },
  get streaming() {
    return this.panel?.streaming ?? false;
  },
  get abortController() {
    return this.panel?.abortController ?? null;
  },

  show() {
    return this.panel?.show() ?? false;
  },
  hide() {
    return this.panel?.hide() ?? false;
  },
  toggle() {
    this.panel?.toggle();
  },
  clear() {
    this.panel?.clear();
  },
  focusPrompt() {
    this.panel?.focusPrompt();
  },
  setPromptText(text) {
    this.panel?.setPromptText(text);
  },
  sendMessage(prompt) {
    return this.panel?.sendMessage(prompt);
  },
  stop() {
    this.panel?.stop();
  },
  regenerateFrom(wrap) {
    this.panel?.regenerateFrom(wrap);
  },
  handleEnabledChange(enabled) {
    if (enabled.value) this.init();
    else this.destroy();
  },

  // Status row is superseded by the settings modal; keep an internal snapshot
  // for the citations pref change path without writing the native findbar.
  updateFindbarStatus() {
    this.aiStatus = {
      citationsEnabled: PREFS.citationsEnabled,
    };
  },

  // --- Lifecycle -----------------------------------------------------------

  init() {
    if (!this.enabled) return;
    if (!this.panel) this.panel = new BrowseBotFloatingPanel();
    this.panel.init();
    this.panel.targetTab = gBrowser.selectedTab;

    if (!this._initialized) {
      this._initialized = true;
      this.onTabSelect = () => {
        this.panel.targetTab = gBrowser.selectedTab;
        this.panel.layout?.schedule();
      };
      this.onFindbarOpen = () => {
        this.attachAskAI();
        this.panel.layout?.schedule();
      };
      this.onFindbarClose = () => this.panel.layout?.schedule();
      gBrowser.tabContainer.addEventListener("TabSelect", this.onTabSelect);
      window.addEventListener("findbaropen", this.onFindbarOpen);
      window.addEventListener("findbarclose", this.onFindbarClose);

      this._addKeymaps = this.addKeymaps.bind(this);
      document.addEventListener("keydown", this._addKeymaps);
      this._citationsListener = addPrefListener(PREFS.CITATIONS_ENABLED, () => {
        this.updateFindbarStatus();
        if (!this.streaming) this.clear();
      });
      this._contextMenuEnabledListener = addPrefListener(
        PREFS.CONTEXT_MENU_ENABLED,
        (pref) => {
          if (pref.value) this.addContextMenuItem();
          else this.removeContextMenuItem();
        }
      );
    }

    this.attachAskAI();
    if (PREFS.contextMenuEnabled) this.addContextMenuItem();
  },

  destroy() {
    // panel.destroy() is the sole lifecycle method that aborts a run.
    this.panel?.destroy();
    this.panel = null;
    this._initialized = false;
    try {
      this.removeListeners();
    } catch {}
    this.removeAskAI();
    this.removeContextMenuItem();
    SettingsModal.hide();
  },

  addKeymaps(e) {
    if (e.key?.toLowerCase() === "escape") {
      if (SettingsModal._modalElement && SettingsModal._modalElement.parentNode) {
        e.preventDefault();
        e.stopPropagation();
        SettingsModal.hide();
      } else if (this.expanded) {
        e.preventDefault();
        e.stopPropagation();
        // Hiding never aborts the run and never closes native text search.
        this.hide();
      }
    }
  },

  removeListeners() {
    if (this.onTabSelect) {
      gBrowser.tabContainer.removeEventListener("TabSelect", this.onTabSelect);
    }
    if (this.onFindbarOpen) window.removeEventListener("findbaropen", this.onFindbarOpen);
    if (this.onFindbarClose) window.removeEventListener("findbarclose", this.onFindbarClose);
    if (this._addKeymaps) document.removeEventListener("keydown", this._addKeymaps);
    removePrefListener(this._citationsListener);
    removePrefListener(this._contextMenuEnabledListener);
    this.onTabSelect = null;
    this.onFindbarOpen = null;
    this.onFindbarClose = null;
    this._addKeymaps = null;
    this._citationsListener = null;
    this._contextMenuEnabledListener = null;
  },

  // --- Native findbar Ask AI facade ----------------------------------------

  attachAskAI() {
    if (!this.enabled) return;
    gBrowser.getFindBar().then((findbar) => {
      if (!findbar || !this.enabled || !this.panel) return;
      // Prune findbars that were destroyed with their tabs.
      for (const fb of this._attachedFindbars) {
        if (!fb.isConnected) this._attachedFindbars.delete(fb);
      }
      const container = findbar.querySelector(".findbar-container");
      if (container && !container.querySelector("#findbar-ask")) {
        const askBtn = parseElement(
          `<button id="findbar-ask" class="zenux-btn-primary" anonid="findbar-ask" title="Ask BrowseBot" aria-label="Ask BrowseBot">Ask AI</button>`
        );
        askBtn.addEventListener("click", () => this._askFromField(findbar._findField));
        container.appendChild(askBtn);
      }
      // Retain Alt+Enter in the native find field.
      if (!this._handleInputKeyPress) {
        this._handleInputKeyPress = this.handleInputKeyPress.bind(this);
      }
      const field = findbar._findField;
      if (field) {
        field.removeEventListener("keypress", this._handleInputKeyPress);
        field.addEventListener("keypress", this._handleInputKeyPress);
        field.placeholder = "Press Alt + Enter to ask AI";
      }
      this._attachedFindbars.add(findbar);
    });
  },

  removeAskAI() {
    for (const findbar of this._attachedFindbars) {
      const field = findbar._findField;
      if (field && this._handleInputKeyPress) {
        field.removeEventListener("keypress", this._handleInputKeyPress);
      }
      findbar.querySelector("#findbar-ask")?.remove();
    }
    this._attachedFindbars.clear();
    document.querySelectorAll("#findbar-ask").forEach((btn) => btn.remove());
    this._handleInputKeyPress = null;
  },

  handleInputKeyPress(e) {
    if (e?.key !== "Enter" || !e?.altKey) return;
    e.preventDefault();
    this._askFromField(e.currentTarget);
  },

  // Copy the current native query into the floating composer, show the panel,
  // and send it when non-empty (existing Ask / Alt+Enter behavior). The native
  // findbar stays open and untouched; only its find field value is cleared.
  _askFromField(field) {
    if (!this.panel) return;
    const query = field?.value?.trim() || "";
    this.panel.setPromptText(query);
    if (field) field.value = "";
    this.show();
    if (query) this.panel.sendFromComposer();
    this.focusPrompt();
  },

  // --- Context menu (delegates to the panel) -------------------------------

  _ensureContextMenuListener(contextMenu) {
    if (!contextMenu) return;
    if (!this._updateContextMenuText) {
      this._updateContextMenuText = this.updateContextMenuText.bind(this);
    }
    contextMenu.removeEventListener("popupshowing", this._updateContextMenuText);
    contextMenu.addEventListener("popupshowing", this._updateContextMenuText);
  },

  addContextMenuItem(retryCount = 0) {
    if (this._contextMenuRetryTimer) {
      clearTimeout(this._contextMenuRetryTimer);
      this._contextMenuRetryTimer = null;
    }
    if (!PREFS.contextMenuEnabled) return;

    const contextMenu = document.getElementById("contentAreaContextMenu");

    if (!contextMenu) {
      if (retryCount < 5) {
        PREFS.debugLog(`Context menu not found, retrying... (attempt ${retryCount + 1}/5)`);
        this._contextMenuRetryTimer = setTimeout(() => {
          this._contextMenuRetryTimer = null;
          this.addContextMenuItem(retryCount + 1);
        }, 200);
      } else {
        PREFS.debugError(
          "Failed to add context menu item after 5 attempts: Context menu not found."
        );
      }
      return;
    }

    if (!this._handleContextMenuClick) {
      this._handleContextMenuClick = this.handleContextMenuClick.bind(this);
    }

    const existingItems = contextMenu.querySelectorAll("#browse-bot-context-menu-item");
    if (existingItems.length > 0) {
      this.contextMenuItem = existingItems[0];
      for (let i = 1; i < existingItems.length; i++) {
        existingItems[i].remove();
      }
      this.contextMenuItem.removeEventListener("command", this._handleContextMenuClick);
      this.contextMenuItem.addEventListener("command", this._handleContextMenuClick);
      this._ensureContextMenuListener(contextMenu);
      return;
    }

    const menuItem = parseElement(
      `<menuitem
      label="Ask AI"
      accesskey="A"
      id = "browse-bot-context-menu-item">
      </menuitem>`,
      "xul"
    );

    menuItem.addEventListener("command", this._handleContextMenuClick);
    this.contextMenuItem = menuItem;

    const searchSelectItem = contextMenu.querySelector("#context-searchselect");

    if (searchSelectItem) {
      // Insert right after the searchselect item
      if (searchSelectItem.nextSibling) {
        contextMenu.insertBefore(menuItem, searchSelectItem.nextSibling);
      } else {
        contextMenu.appendChild(menuItem);
      }
    } else {
      // Fallback: insert after context-sep-redo separator
      const redoSeparator = contextMenu.querySelector("#context-sep-redo");
      if (redoSeparator) {
        if (redoSeparator.nextSibling) {
          contextMenu.insertBefore(menuItem, redoSeparator.nextSibling);
        } else {
          contextMenu.appendChild(menuItem);
        }
      } else {
        // Final fallback: don't add the menu item if neither element is found
        return;
      }
    }

    this._ensureContextMenuListener(contextMenu);
  },

  removeContextMenuItem() {
    if (this._contextMenuRetryTimer) {
      clearTimeout(this._contextMenuRetryTimer);
      this._contextMenuRetryTimer = null;
    }
    const contextMenu = document.getElementById("contentAreaContextMenu");
    if (contextMenu && this._updateContextMenuText) {
      contextMenu.removeEventListener("popupshowing", this._updateContextMenuText);
    }
    if (this._handleContextMenuClick && this.contextMenuItem) {
      this.contextMenuItem.removeEventListener("command", this._handleContextMenuClick);
    }
    document.querySelectorAll("#browse-bot-context-menu-item").forEach((item) => item.remove());
    this.contextMenuItem = null;
  },

  handleContextMenuClick: async function () {
    const selection = await messageManagerAPI.getSelectedText();
    let finalMessage;
    if (selection.hasSelection) {
      const commandTemplate = PREFS.contextMenuCommandWithSelection;
      finalMessage = commandTemplate.replace("{selection}", selection.selectedText);
    } else {
      finalMessage = PREFS.contextMenuCommandNoSelection;
    }
    this.expanded = true;
    if (PREFS.contextMenuAutoSend) {
      this.sendMessage(finalMessage);
      this.focusPrompt();
    } else {
      this.setPromptText(finalMessage);
      this.show();
      this.focusPrompt();
    }
  },

  handleContextMenuPrefChange(pref) {
    if (pref.value) this.addContextMenuItem();
    else this.removeContextMenuItem();
  },

  updateContextMenuText() {
    if (!PREFS.contextMenuEnabled) return;
    const items = document.querySelectorAll("#browse-bot-context-menu-item");
    if (items.length > 1) {
      for (let i = 1; i < items.length; i++) {
        items[i].remove();
      }
      this.contextMenuItem = items[0];
    } else if (items.length === 1) {
      this.contextMenuItem = items[0];
    }
    if (!this.contextMenuItem) return;
    const hasSelection = gContextMenu?.isTextSelected === true;
    this.contextMenuItem.label = hasSelection ? "Ask AI" : "Summarize with AI";
  },
};