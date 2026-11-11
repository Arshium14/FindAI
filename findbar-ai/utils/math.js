/**
 * Lazy KaTeX loader for chat math. Assets are vendored next to the mod so
 * chrome:// imports resolve offline; if they fail to load, messages keep the
 * raw LaTeX fallback (still copyable) instead of breaking rendering.
 */

let katexModule = null;
let katexPromise = null;
let katexFailed = false;

function assetUrl(name) {
  return new URL(`../vendor/katex/${name}`, import.meta.url).href;
}

function ensureKatexCss() {
  if (typeof document === "undefined" || !document.head) return;
  if (document.querySelector("link[data-browsebot-katex]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = assetUrl("katex.min.css");
  link.setAttribute("data-browsebot-katex", "");
  document.head.appendChild(link);
}

function loadKatex() {
  if (katexModule) return Promise.resolve(katexModule);
  if (katexFailed) return Promise.reject(new Error("KaTeX unavailable"));
  if (!katexPromise) {
    katexPromise = import(assetUrl("katex.mjs"))
      .then((mod) => {
        katexModule = mod.default ?? mod;
        ensureKatexCss();
        return katexModule;
      })
      .catch((e) => {
        katexFailed = true;
        katexPromise = null;
        console.warn("BrowseBot: KaTeX failed to load; math stays as raw LaTeX.", e);
        throw e;
      });
  }
  return katexPromise;
}

function renderOptions(displayMode) {
  return { displayMode, throwOnError: false, output: "html", strict: false, trust: false };
}

async function mathHtml(latex, displayMode = false) {
  const katex = await loadKatex();
  return katex.renderToString(latex, renderOptions(displayMode));
}

function renderMathElement(el, katex) {
  const body = el.querySelector(".zh-math-body");
  if (!body) return;
  const latex = el.getAttribute("data-latex") || "";
  const displayMode = el.getAttribute("data-display") === "1";
  try {
    body.innerHTML = katex.renderToString(latex, renderOptions(displayMode));
    el.classList.add("is-rendered");
    el.classList.remove("is-error");
  } catch {
    el.classList.add("is-error");
  }
}

const PENDING_SELECTOR = ".zh-math:not(.is-rendered):not(.is-error)";

async function hydrateMath(root) {
  try {
    if (!root?.querySelectorAll) return;
    if (!root.querySelectorAll(PENDING_SELECTOR).length) return;
    const katex = await loadKatex();
    for (const el of root.querySelectorAll(PENDING_SELECTOR)) {
      renderMathElement(el, katex);
    }
  } catch {
    // Raw LaTeX fallback stays visible and copyable.
  }
}

export { loadKatex, mathHtml, hydrateMath };