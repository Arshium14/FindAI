import { messageManagerAPI } from "../messageManager.js";
import { parseElement, escapeXmlAttribute } from "../../utils/parse.js";
import { fuzzyFilterSort } from "../../utils/fuzzy.js";

export function listOpenTabs() {
  try {
    const tabs = gZenWorkspaces?.allStoredTabs || gBrowser?.tabs || [];
    return tabs
      .filter((tab) => tab && !tab.hidden && !tab.closing && !tab.hasAttribute("pending"))
      .map((tab) => ({
        tab,
        title: tab.label || tab.linkedBrowser?.currentURI?.spec || "Untitled",
        url: tab.linkedBrowser?.currentURI?.spec || "",
        icon: tab.image || "",
      }))
      .filter((t) => t.url && t.url !== "about:newtab" && t.url !== "about:blank");
  } catch {
    return [];
  }
}

export function tokenBeforeCaret(text, caret = text.length) {
  const before = text.slice(0, caret);
  const match = before.match(/(^|\s)@([^@\n]*)$/);
  if (!match) return null;
  return {
    kind: "at",
    filter: match[2].toLowerCase(),
    start: caret - match[2].length - 1,
  };
}

function referenceTokenTitle(ref) {
  return String(ref.originalTokenTitle || ref.title || "");
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findReferenceMatches(text, refs) {
  const candidates = refs
    .map((ref, index) => ({ ref, title: referenceTokenTitle(ref), index }))
    .filter((candidate) => candidate.title)
    .sort((a, b) => b.title.length - a.title.length || a.index - b.index);
  if (candidates.length === 0) return [];
  const titles = [...new Set(candidates.map((candidate) => candidate.title))];
  const pattern = new RegExp(`(^|\\s)@(${titles.map(escapeRegExp).join("|")})(?=\\s|$)`, "g");
  const matches = [];
  let match;
  while ((match = pattern.exec(text))) {
    const title = match[2];
    const start = match.index + match[1].length;
    const token = `@${title}`;
    matches.push({
      refs: candidates.filter((candidate) => candidate.title === title).map((candidate) => candidate.ref),
      token,
      title,
      start,
      end: start + token.length,
    });
  }
  return matches;
}

export function createReferenceChip(ref, { removable = false, onRemove = null } = {}) {
  const chip = parseElement(
    `<span class="bb-ref-chip">${ref.icon ? `<img src="${escapeXmlAttribute(ref.icon)}" />` : ""}<span>${escapeXmlAttribute(ref.title)}</span>${removable ? `<span class="bb-ref-remove"><img src="chrome://global/skin/icons/close.svg" /></span>` : ""}</span>`
  );
  for (const img of chip.querySelectorAll("img")) {
    img.addEventListener("error", () => img.remove());
  }
  if (removable) {
    chip.querySelector(".bb-ref-remove")?.addEventListener("mousedown", (event) => {
      event.preventDefault();
      onRemove?.(ref);
    });
  }
  return chip;
}

export function insertReferenceChips(contentDiv, refs) {
  if (!refs || refs.length === 0) return;
  const doc = contentDiv.ownerDocument;
  const walker = doc.createTreeWalker(contentDiv, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const startNode of textNodes) {
    if (startNode.parentElement?.closest?.("pre, code")) continue;
    let node = startNode;
    for (;;) {
      const best = findReferenceMatches(node.textContent, refs)[0];
      if (!best) break;
      const parent = node.parentNode;
      if (!parent) break;
      parent.insertBefore(doc.createTextNode(node.textContent.slice(0, best.start)), node);
      parent.insertBefore(createReferenceChip(best.refs[0]), node);
      const after = doc.createTextNode(node.textContent.slice(best.end));
      parent.replaceChild(after, node);
      node = after;
    }
  }
}

export class TabReferenceController {
  constructor({ readTab = messageManagerAPI.getPageTextContentForTab.bind(messageManagerAPI) } = {}) {
    this.readTab = readTab;
    this.pending = [];
    this.text = "";
  }

  listTabs(filter) {
    return fuzzyFilterSort(listOpenTabs(), filter, (tab) => [tab.title, tab.url]).slice(0, 8);
  }

  select(item, text, caret, token) {
    const nextText = `${text.slice(0, token.start)}@${item.title} ${text.slice(caret)}`;
    this.pending = this.pending.filter((ref) => ref.tab !== item.tab);
    this.pending.push(item);
    this.text = nextText;
    return { text: nextText, caret: token.start + item.title.length + 2 };
  }

  sync(text) {
    this.text = text;
    const before = this.pending.length;
    const matchedRefs = new Set(findReferenceMatches(text, this.pending).flatMap((match) => match.refs));
    this.pending = this.pending.filter((ref) => matchedRefs.has(ref));
    return this.pending.length !== before;
  }

  remove(ref, text) {
    const matches = findReferenceMatches(text, this.pending).filter((match) =>
      match.refs.some((pending) => pending.tab === ref.tab)
    );
    let nextText = text;
    for (const match of matches.reverse()) {
      nextText = `${nextText.slice(0, match.start)}${nextText.slice(match.end)}`;
    }
    this.pending = this.pending.filter((pending) => pending.tab !== ref.tab);
    this.text = nextText.replace(/ {2,}/g, " ");
    return this.text;
  }

  clear() {
    this.pending = [];
    this.text = "";
  }

  renderChips(container, onChange) {
    container.replaceChildren();
    for (const ref of this.pending) {
      container.appendChild(
        createReferenceChip(ref, {
          removable: true,
          onRemove: () => {
            const nextText = this.remove(ref, this.text);
            this.renderChips(container, onChange);
            onChange?.(nextText);
          },
        })
      );
    }
  }

  async resolve(text, { maxChars = 0 } = {}) {
    const refs = [];
    const warnings = [];
    const matches = findReferenceMatches(text, this.pending);
    let prompt = "";
    let cursor = 0;
    for (const match of matches) {
      prompt += `${text.slice(cursor, match.start)}${match.title}`;
      cursor = match.end;
    }
    prompt += text.slice(cursor);
    this.text = text;
    for (const pending of this.pending) {
      if (!matches.some((match) => match.refs.includes(pending))) continue;
      let page = null;
      try {
        if (!pending.tab || pending.tab.isConnected === false || pending.tab.closing) {
          warnings.push(`Tab “${pending.title}” is closed or no longer connected.`);
          continue;
        }
        page = await this.readTab(pending.tab);
      } catch (error) {
        page = null;
      }
      if (!page) {
        if (!warnings.some((warning) => warning.includes(`“${pending.title}”`))) {
          warnings.push(`Could not read tab “${pending.title}”; it may be closed, unloaded, or an internal page.`);
        }
        continue;
      }
      const raw = String(page.textContent || "").trim();
      if (!raw) warnings.push(`No readable text was found in tab “${pending.title}”.`);
      const content = maxChars > 0 && raw.length > maxChars
        ? `${raw.slice(0, maxChars)}\n\n[Content truncated.]`
        : raw;
      refs.push({
        ...pending,
        originalTokenTitle: referenceTokenTitle(pending),
        title: page.title || pending.title,
        url: page.url || pending.url,
        text: content || "(No readable text extracted from this tab.)",
      });
    }
    return { prompt, refs, warnings };
  }
}
