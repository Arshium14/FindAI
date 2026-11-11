import test from "node:test";
import assert from "node:assert/strict";
import { parseMD } from "../../findbar-ai/utils/markdown.js";
import { loadKatex, mathHtml, hydrateMath } from "../../findbar-ai/utils/math.js";

const md = (text) => parseMD(text, false);

test("inline $...$ becomes a math span with raw LaTeX and a copy button", () => {
  const html = md("Energy is $E = mc^2$ exactly.");
  assert.match(html, /<span class="zh-math" data-latex="E = mc\^2" data-display="0">/);
  assert.match(html, /class="zh-math-body">E = mc\^2</);
  assert.match(html, /class="zh-math-copy"[^>]*>Copy</);
  assert.ok(html.includes("Energy is "));
  assert.ok(html.includes(" exactly."));
});

test("\\(...\\) renders as inline math", () => {
  const html = md("Value \\(\\alpha + \\beta\\) here.");
  assert.match(html, /data-latex="\\alpha \+ \\beta" data-display="0"/);
});

test("single-line $$...$$ is display math", () => {
  const html = md("Before $$x^2 + y^2 = z^2$$ after");
  assert.match(html, /class="zh-math zh-math-display" data-latex="x\^2 \+ y\^2 = z\^2" data-display="1"/);
});

test("multi-line $$ block becomes a display div between paragraphs", () => {
  const html = md("Intro\n\n$$\n\\frac{a}{b}\n$$\n\nOutro");
  assert.match(html, /<div class="zh-math zh-math-display" data-latex="\\frac\{a\}\{b\}" data-display="1">/);
  assert.match(html, /<p>Intro<\/p>/);
  assert.match(html, /<p>Outro<\/p>/);
  assert.ok(html.indexOf("Intro") < html.indexOf("zh-math"));
  assert.ok(html.indexOf("zh-math") < html.indexOf("Outro"));
});

test("multi-line \\[...\\] block becomes display math", () => {
  const html = md("Intro\n\n\\[\n\\sqrt[3]{x}\n\\]\n\nOutro");
  assert.match(html, /data-latex="\\sqrt\[3\]\{x\}" data-display="1"/);
  assert.match(html, /<div class="zh-math zh-math-display"/);
});

test("two display blocks on separate lines stay separate", () => {
  const html = md("$$a$$\n\n$$b$$");
  const matches = html.match(/data-latex="[ab]" data-display="1"/g) || [];
  assert.equal(matches.length, 2);
});

test("two display maths on one line are not merged into one block", () => {
  const html = md("$$a$$ and $$b$$");
  const matches = html.match(/data-latex="[ab]"/g) || [];
  assert.equal(matches.length, 2);
  assert.ok(!html.includes("a$$ and $$b"));
});

test("multiple inline maths in one paragraph each get a copy button", () => {
  const html = md("$x$ plus $y$ equals $z$");
  const spans = html.match(/class="zh-math" data-latex/g) || [];
  const copies = html.match(/zh-math-copy/g) || [];
  assert.equal(spans.length, 3);
  assert.equal(copies.length, 3);
});

test("math inside list items and headings renders", () => {
  const html = md("# Title $x^2$\n\n- item $y_1$\n- plain");
  assert.match(html, /<h1>Title <span class="zh-math" data-latex="x\^2"/);
  assert.match(html, /<li>item <span class="zh-math" data-latex="y_1"/);
});

test("currency amounts are not treated as math", () => {
  for (const text of [
    "It costs $5 to $10 today",
    "Prices: $5.00 and $6.00",
    "Range $5-$10",
    "He paid $5 and she paid $10",
    "Only $9.99",
  ]) {
    assert.ok(!md(text).includes("zh-math"), `should not render math: ${text}`);
  }
});

test("real math next to currency still renders", () => {
  const html = md("costs $5 but $x^2$ is math");
  assert.match(html, /data-latex="x\^2"/);
  assert.ok(html.includes("costs $5 but "));
});

test("escaped dollars render literally and never open math", () => {
  const html = md("Price \\$100 or \\$200");
  assert.ok(!html.includes("zh-math"));
  assert.ok(html.includes("$100 or $200"));
});

test("inline code protects dollar math", () => {
  const html = md("Use `$x^2$` literally");
  assert.ok(!html.includes("zh-math"));
  assert.match(html, /<code>\$x\^2\$<\/code>/);
});

test("code fences protect display math", () => {
  const html = md("```\n$$x^2$$\n\\[y\\]\n```");
  assert.ok(!html.includes("zh-math"));
  assert.match(html, /zh-codeblock/);
  assert.match(html, /zh-codeblock-copy/);
});

test("LaTeX with HTML special characters is escaped in attributes and fallback", () => {
  const html = md("$a < b$ and $c > d$");
  assert.match(html, /data-latex="a &lt; b"/);
  assert.match(html, /data-latex="c &gt; d"/);
  assert.ok(!html.includes("< b"));
  const quoted = md('$a"b$');
  assert.match(quoted, /data-latex="a&quot;b"/);
});

test("script injection through math is neutralized", () => {
  const html = md('$<script>alert(1)</script>$');
  assert.ok(!html.includes("<script>"));
  assert.match(html, /data-latex="&lt;script&gt;/);
});

test("unclosed math during streaming stays raw text", () => {
  const html = md("partial $x^2");
  assert.ok(!html.includes("zh-math"));
  assert.ok(html.includes("$x^2"));
  const block = md("$$\n\\frac{a}{b}");
  assert.ok(!block.includes("zh-math"));
});

test("empty $$ delimiters do not create math", () => {
  assert.ok(!md("$$$$").includes("zh-math"));
  assert.ok(!md("$ $").includes("zh-math"));
});

test("asterisks inside math are not consumed by emphasis parsing", () => {
  const html = md("product $a*b*c$ done");
  assert.match(html, /data-latex="a\*b\*c"/);
  assert.ok(!html.includes("<em>"));
});

test("bold and links still work alongside math", () => {
  const html = md("**bold** $x$ [site](https://example.com)");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /data-latex="x"/);
  assert.match(html, /<a href="https:\/\/example\.com"/);
});

test("citation spans pass through untouched next to math", () => {
  const cite = '<span class="citation-link" data-url="https://a.test">1</span>';
  const html = md(`${cite} shows $x$`);
  assert.ok(html.includes(cite));
  assert.match(html, /data-latex="x"/);
});

test("loadKatex resolves the vendored KaTeX module", async () => {
  const katex = await loadKatex();
  assert.equal(katex.version, "0.19.1");
  assert.equal(typeof katex.renderToString, "function");
});

test("mathHtml renders real KaTeX output", async () => {
  const html = await mathHtml("x^2", false);
  assert.match(html, /class="katex"/);
  const display = await mathHtml("\\frac{a}{b}", true);
  assert.match(display, /katex-display/);
});

test("mathHtml never throws on invalid LaTeX", async () => {
  const html = await mathHtml("\\frac{", false);
  assert.equal(typeof html, "string");
  assert.match(html, /katex-error/);
});

function fakeMathEl(latex, display) {
  const el = {
    attrs: { "data-latex": latex, "data-display": display ? "1" : "0" },
    classes: new Set(),
    body: { innerHTML: "raw fallback" },
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    querySelector(sel) {
      return sel === ".zh-math-body" ? this.body : null;
    },
    classList: {
      add: (c) => el.classes.add(c),
      remove: (c) => el.classes.delete(c),
    },
  };
  return el;
}

test("hydrateMath fills math bodies and marks them rendered", async () => {
  const inline = fakeMathEl("x^2", false);
  const display = fakeMathEl("\\frac{a}{b}", true);
  const root = { querySelectorAll: () => [inline, display] };
  await hydrateMath(root);
  assert.match(inline.body.innerHTML, /class="katex"/);
  assert.match(display.body.innerHTML, /katex-display/);
  assert.ok(inline.classes.has("is-rendered"));
  assert.ok(display.classes.has("is-rendered"));
});

test("hydrateMath on a root without math is a no-op", async () => {
  const root = { querySelectorAll: () => [] };
  await hydrateMath(root);
});