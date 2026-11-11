/**
 * Dependency-free markdown renderer for chat messages. Replaces the Sine
 * runtime parseMD import, which no longer resolves. Covers what models
 * actually emit: headings, bold/italic/code, lists, quotes, tables, links,
 * fenced code blocks, and LaTeX math ($...$, $$...$$, \(...\), \[...\]).
 * Citation spans are passed through untouched. Math is emitted as raw-LaTeX
 * fallback markup that utils/math.js upgrades to KaTeX once it loads.
 */
import { parseElement } from "../../utils/parse.js";
import { highlightCode } from "../../utils/code-highlight.js";
import { hydrateMath } from "./math.js";

const CITE_RE = /<span class="citation-link"[^>]*>.*?<\/span>/g;
const CLOSED_FENCE_RE = /^```(\w*)\n([\s\S]*?)\n```/gm;
const OPEN_FENCE_RE = /^```(\w*)\n([\s\S]*)$/m;
const BLOCK_DOLLAR_RE = /^[ \t]*\$\$((?:(?!\$\$)[\s\S])+?)\$\$[ \t]*$/gm;
const BLOCK_BRACKET_RE = /^[ \t]*\\\[([\s\S]+?)\\\][ \t]*$/gm;
const INLINE_DISPLAY_RE = /\$\$((?:(?!\$\$)[\s\S])+?)\$\$/g;
const INLINE_BRACKET_RE = /\\\[([\s\S]+?)\\\]/g;
const INLINE_PAREN_RE = /\\\(((?:(?!\\\))[\s\S])+?)\\\)/g;
const INLINE_TEX_RE = /\$([^$\n]+?)\$/g;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stashPlaceholders(text, regex, stash) {
  return text.replace(regex, (m) => {
    stash.push(m);
    return `%%STASH${stash.length - 1}%%`;
  });
}

function mathMarkup(latex, displayMode, block = false) {
  const tag = block ? "div" : "span";
  const cls = displayMode ? "zh-math zh-math-display" : "zh-math";
  const escaped = escapeHtml(latex);
  return (
    `<${tag} class="${cls}" data-latex="${escaped}" data-display="${displayMode ? 1 : 0}">` +
    `<${tag} class="zh-math-body">${escaped}</${tag}>` +
    `<span class="zh-math-copy" role="button" tabindex="0" title="Copy LaTeX source">Copy</span>` +
    `</${tag}>`
  );
}

function stashMath(text, regex, stash, displayMode) {
  return text.replace(regex, (_m, latex) => {
    const trimmed = latex.trim();
    if (!trimmed) return _m;
    stash.push(mathMarkup(trimmed, displayMode));
    return `%%STASH${stash.length - 1}%%`;
  });
}

function stashInlineTex(text, stash) {
  let out = "";
  let last = 0;
  let m;
  INLINE_TEX_RE.lastIndex = 0;
  while ((m = INLINE_TEX_RE.exec(text))) {
    const body = m[1];
    // Currency guard: no whitespace hugging the delimiters, no digit right
    // after the closing $, and not a bare number ("$5 to $10", "$5-$10").
    const after = text[m.index + m[0].length];
    const isMath =
      !/^\s/.test(body) &&
      !/\s$/.test(body) &&
      !(after && /\d/.test(after)) &&
      !/^[\d.,]+$/.test(body);
    if (!isMath) {
      // Re-scan just past the opening $ so a rejected currency opener can
      // still serve as the opener of a later real pair ("$5 but $x^2$").
      INLINE_TEX_RE.lastIndex = m.index + 1;
      continue;
    }
    out += text.slice(last, m.index);
    stash.push(mathMarkup(body, false));
    out += `%%STASH${stash.length - 1}%%`;
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

function renderInline(text) {
  const stash = [];
  text = stashPlaceholders(text, CITE_RE, stash);
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    stash.push(`<code>${escapeHtml(code)}</code>`);
    return `%%STASH${stash.length - 1}%%`;
  });
  text = text.replace(/\\\$/g, () => {
    stash.push("$");
    return `%%STASH${stash.length - 1}%%`;
  });
  text = stashMath(text, INLINE_DISPLAY_RE, stash, true);
  text = stashMath(text, INLINE_BRACKET_RE, stash, true);
  text = stashMath(text, INLINE_PAREN_RE, stash, false);
  text = stashInlineTex(text, stash);
  text = escapeHtml(text);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|\W)\*([^*\n]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => {
    const safe = escapeHtml(url).replace(/"/g, "%22");
    return `<a href="${safe}" target="_blank" rel="noopener">${label}</a>`;
  });
  return text.replace(/%%STASH(\d+)%%/g, (_m, i) => stash[Number(i)]);
}

function isTableDivider(line) {
  return /^\|?[\s:|-]+\|?[\s:|-]*$/.test(line) && line.includes("-");
}

function renderTable(header, rows) {
  const cells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => `<th>${renderInline(c.trim())}</th>`)
      .join("");
  const bodyCells = (line) =>
    line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => `<td>${renderInline(c.trim())}</td>`)
      .join("");
  return (
    `<table><thead><tr>${cells(header)}</tr></thead><tbody>` +
    rows.map((r) => `<tr>${bodyCells(r)}</tr>`).join("") +
    `</tbody></table>`
  );
}

function renderCodeBlock(lang, code, complete = true) {
  const normalizedLang = String(lang || "").trim();
  const label = escapeHtml(normalizedLang || "code");
  const highlighted = highlightCode(String(code).replace(/\n$/, ""), normalizedLang);
  const streaming = complete ? "" : " is-streaming";
  return `<div class="zh-codeblock${streaming}"><div class="zh-codeblock-head"><span>${label}</span><span class="zh-codeblock-copy" role="button" tabindex="0">Copy</span></div><pre><code>${highlighted}</code></pre></div>`;
}

function renderBlocks(text) {
  const codeBlocks = [];
  const stashCode = (lang, code, complete) => {
    codeBlocks.push({ lang, code, complete });
    return `%%CODEBLOCK${codeBlocks.length - 1}%%`;
  };
  text = String(text).replace(CLOSED_FENCE_RE, (_m, lang, code) => stashCode(lang, code, true));
  text = text.replace(OPEN_FENCE_RE, (_m, lang, code) => stashCode(lang, code, false));
  const mathBlocks = [];
  const stashMathBlock = (_m, latex) => {
    const trimmed = latex.trim();
    if (!trimmed) return _m;
    mathBlocks.push(trimmed);
    return `%%MATHBLOCK${mathBlocks.length - 1}%%`;
  };
  text = text.replace(BLOCK_DOLLAR_RE, stashMathBlock);
  text = text.replace(BLOCK_BRACKET_RE, stashMathBlock);
  const lines = String(text).split("\n");
  const html = [];
  let para = [];
  let list = null;

  const flushPara = () => {
    if (para.length) html.push(`<p>${para.join("<br />")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) html.push(list.ordered ? `<ol>${list.items}</ol>` : `<ul>${list.items}</ul>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }
    const codeMatch = trimmed.match(/^%%CODEBLOCK(\d+)%%$/);
    if (codeMatch) {
      flushPara();
      flushList();
      const block = codeBlocks[Number(codeMatch[1])];
      html.push(renderCodeBlock(block.lang, block.code, block.complete));
      continue;
    }
    const mathMatch = trimmed.match(/^%%MATHBLOCK(\d+)%%$/);
    if (mathMatch) {
      flushPara();
      flushList();
      html.push(mathMarkup(mathBlocks[Number(mathMatch[1])], true, true));
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)/);
    if (heading) {
      flushPara();
      flushList();
      html.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flushPara();
      flushList();
      html.push("<hr />");
      continue;
    }
    const quote = line.match(/^>(.*)$/);
    if (quote) {
      flushPara();
      flushList();
      html.push(`<blockquote>${renderInline(quote[1].trim())}</blockquote>`);
      continue;
    }
    if (trimmed.includes("|") && i + 1 < lines.length && isTableDivider(lines[i + 1].trim())) {
      flushPara();
      flushList();
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(lines[i]);
        i++;
      }
      i--;
      html.push(renderTable(trimmed, rows));
      continue;
    }
    const ordered = trimmed.match(/^\d+\.\s+(.*)/);
    const unordered = trimmed.match(/^[-*]\s+(.*)/);
    if (ordered || unordered) {
      flushPara();
      const isOrdered = !!ordered;
      const item = renderInline((ordered || unordered)[1]);
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: "" };
      }
      list.items += `<li>${item}</li>`;
      continue;
    }
    flushList();
    para.push(renderInline(trimmed));
  }
  flushPara();
  flushList();
  return html.join("\n");
}

function parseMD(markdown, convertHTML = true) {
  const body = renderBlocks(markdown ?? "");
  if (!convertHTML) return body;
  const el = parseElement(`<div class="markdown-body"></div>`);
  el.innerHTML = body;
  queueMicrotask(() => hydrateMath(el));
  return el;
}

export { parseMD };
export default parseMD;