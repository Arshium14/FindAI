import { parseMD } from "./markdown.js";
import { hydrateMath } from "./math.js";
import { parseElement } from "../../utils/parse.js";

function messageCopyText(wrap) {
  return (wrap?.querySelector(".message-content")?.textContent || "").trim();
}

function flashActionIcon(btn, src, ms = 1200) {
  const img = btn?.querySelector("img");
  if (!img) return;
  const prev = img.getAttribute("src");
  img.setAttribute("src", src);
  setTimeout(() => {
    if (btn.isConnected) img.setAttribute("src", prev);
  }, ms);
}

async function copyChatMessage(wrap, btn) {
  const text = messageCopyText(wrap);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    if (btn) flashActionIcon(btn, "chrome://global/skin/icons/check.svg");
  } catch {}
}

function buildMessageActions({ regenerate = true } = {}) {
  const actions = parseElement(`<div class="bb-msg-actions"></div>`);
  const copyBtn = parseElement(
    `<button class="bb-msg-copy zenux-icon-btn" tooltiptext="Copy message"><img src="chrome://global/skin/icons/edit-copy.svg" width="14" height="14" alt="" /></button>`
  );
  actions.appendChild(copyBtn);
  if (regenerate) {
    const regenBtn = parseElement(
      `<button class="bb-msg-regen zenux-icon-btn" tooltiptext="Regenerate response"><img src="chrome://global/skin/icons/reload.svg" width="14" height="14" alt="" /></button>`
    );
    actions.appendChild(regenBtn);
  }
  return actions;
}

function attachMessageActions(wrap, { regenerate = true, onRegenerate } = {}) {
  if (!wrap || wrap.querySelector(":scope > .bb-msg-actions")) return;
  const actions = buildMessageActions({ regenerate });
  actions.querySelector(".bb-msg-copy")?.addEventListener("click", (e) => {
    e.stopPropagation();
    copyChatMessage(wrap, e.currentTarget);
  });
  if (regenerate) {
    actions.querySelector(".bb-msg-regen")?.addEventListener("click", (e) => {
      e.stopPropagation();
      onRegenerate?.(wrap, e.currentTarget);
    });
  }
  wrap.appendChild(actions);
}

// parseMD with convertHTML=false returns a string, not an element.
function renderStreamText(contentDiv, fullText) {
  try {
    contentDiv.innerHTML = parseMD(fullText, false);
    hydrateMath(contentDiv);
  } catch {
    contentDiv.textContent = fullText + "\n\n[Error rendering markdown]";
  }
}

function extractErrorText(e) {
  let errorText = e?.message || String(e);
  try {
    const parsed = JSON.parse(e.message);
    errorText = parsed?.error?.message || parsed?.message || errorText;
  } catch {}
  return errorText;
}

function isProviderBalanceExhausted(provider, text) {
  return (
    provider?.name === "pollinations" &&
    typeof provider.isBalanceExhaustedText === "function" &&
    provider.isBalanceExhaustedText(text)
  );
}

function setStreamingControls({ sendBtn, stopBtn }, streaming, onIdle) {
  if (sendBtn) sendBtn.style.display = streaming ? "none" : "flex";
  if (stopBtn) stopBtn.style.display = streaming ? "flex" : "none";
  if (!streaming && onIdle) onIdle();
}

function openChatLink(href) {
  try {
    openTrustedLinkIn(href, "tab");
  } catch {}
}

async function writeClipboardText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {}
  // Chrome documents can lack the async clipboard API; use the XPCOM helper.
  Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
}

async function flashCopyButton(button, write) {
  try {
    await write();
    button.textContent = "Copied!";
    button.classList.add("is-copied");
  } catch {
    button.textContent = "Copy failed";
    button.classList.add("is-error");
  }
  setTimeout(() => {
    if (!button.isConnected) return;
    button.textContent = "Copy";
    button.classList.remove("is-copied", "is-error");
  }, 1500);
}

async function copyChatCode(copyButton) {
  const codeEl = copyButton.closest(".zh-codeblock")?.querySelector("pre code");
  if (!codeEl) return;
  await flashCopyButton(copyButton, () => writeClipboardText(codeEl.textContent));
}

async function copyChatMath(copyButton) {
  const latex = copyButton.closest(".zh-math")?.getAttribute("data-latex");
  if (!latex) return;
  await flashCopyButton(copyButton, () => writeClipboardText(latex));
}

function handleCopyClick(target) {
  const copyButton = target.closest?.(".zh-codeblock-copy, .zh-math-copy");
  if (!copyButton) return false;
  if (copyButton.classList.contains("zh-math-copy")) copyChatMath(copyButton);
  else copyChatCode(copyButton);
  return true;
}

function attachChatMessageHandlers(container, { onCitation } = {}) {
  container.addEventListener("click", async (e) => {
    if (handleCopyClick(e.target)) return;
    if (onCitation) {
      const citation = e.target.closest?.(".citation-link");
      if (citation) {
        onCitation(citation, e);
        return;
      }
    }
    const anchor = e.target?.closest?.("a[href]");
    if (!anchor) return;
    e.preventDefault();
    openChatLink(anchor.href);
  });

  container.addEventListener("auxclick", (e) => {
    if (e.button === 1) {
      const anchor = e.target?.closest?.("a[href]");
      if (!anchor) return;
      e.preventDefault();
      openChatLink(anchor.href);
    }
  });

  container.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    if (handleCopyClick(e.target)) e.preventDefault();
  });
}

export {
  renderStreamText,
  extractErrorText,
  isProviderBalanceExhausted,
  setStreamingControls,
  openChatLink,
  copyChatCode,
  copyChatMath,
  attachChatMessageHandlers,
  messageCopyText,
  copyChatMessage,
  buildMessageActions,
  attachMessageActions,
};
