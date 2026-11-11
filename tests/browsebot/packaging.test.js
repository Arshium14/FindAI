import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const exists = (path) => fs.existsSync(path);

test("floating styles do not position native findbar or write Arc preferences", () => {
  const css = read("findbar-ai/styles/findbar.css");
  assert.doesNotMatch(css, /findbar\s*\{[^}]*position\s*:/s);
  assert.match(css, /#browse-bot-panel/);
  const js = [
    "findbar-ai/floating-panel.js",
    "findbar-ai/findbar-ai.uc.js",
    "findbar-ai/panel/layout-coordinator.js",
  ]
    .map(read)
    .join("\n");
  assert.doesNotMatch(js, /setPref\([^\n]*arc-|Services\.prefs\.[^\n]*arc-/);
});

test("Sine metadata retains direct source script and chrome style", () => {
  const theme = JSON.parse(read("findbar-ai/theme.json"));
  assert.equal(theme.id, "browse-bot");
  assert.equal(theme.style.chrome, "style.css");
  assert.deepEqual(theme.scripts["browse-bot.uc.mjs"].include, [
    "chrome://browser/content/browser.xhtml",
  ]);
  JSON.parse(read("findbar-ai/preferences.json"));
});

test("dead MINIMAL and PERSIST preferences are removed from source and metadata", () => {
  const prefs = read("findbar-ai/utils/prefs.js");
  assert.doesNotMatch(prefs, /static MINIMAL\b/);
  assert.doesNotMatch(prefs, /static PERSIST\b/);
  assert.doesNotMatch(prefs, /get minimal\(/);
  assert.doesNotMatch(prefs, /get persistChat\(/);
  assert.doesNotMatch(prefs, /get pseudoBg\(/);

  const settings = read("findbar-ai/settings.js");
  assert.doesNotMatch(settings, /PREFS\.MINIMAL/);
  assert.doesNotMatch(settings, /PREFS\.PERSIST/);

  const json = JSON.parse(read("findbar-ai/preferences.json"));
  const props = json.map((entry) => entry.property).filter(Boolean);
  assert.ok(!props.includes("extension.browse-bot.findbar-ai.minimal"));
  assert.ok(!props.includes("extension.browse-bot.findbar-ai.persist-chat"));
});

test("pseudo background option is removed and height is surfaced in metadata", () => {
  const json = JSON.parse(read("findbar-ai/preferences.json"));
  const bg = json.find(
    (entry) => entry.property === "extension.browse-bot.findbar-ai.background-style"
  );
  assert.ok(bg);
  assert.deepEqual(
    bg.options.map((o) => o.value),
    ["solid", "acrylic"]
  );

  const height = json.find(
    (entry) => entry.property === "extension.browse-bot.findbar-ai.height"
  );
  assert.ok(height, "HEIGHT preference row must exist in preferences.json");
  assert.equal(height.defaultValue, 600);

  const style = read("findbar-ai/style.css");
  assert.doesNotMatch(style, /background-style",\s*"pseudo"/);
});

test("pseudo-bg.css is deleted or contains no native findbar positioning", () => {
  if (!exists("findbar-ai/styles/pseudo-bg.css")) return;
  const css = read("findbar-ai/styles/pseudo-bg.css");
  assert.doesNotMatch(css, /:has\([^)]*findbar/);
  assert.doesNotMatch(css, /--findbar-[xy]/);
});

test("remember-dimensions and corner descriptions reference the floating panel", () => {
  const json = JSON.parse(read("findbar-ai/preferences.json"));
  const remember = json.find(
    (entry) => entry.property === "extension.browse-bot.findbar-ai.remember-dimensions"
  );
  assert.match(remember.description, /width and height/i);
  const corner = json.find(
    (entry) => entry.property === "extension.browse-bot.findbar-ai.position"
  );
  assert.match(corner.description, /floating.panel/i);
});

test("root entries and package scripts are BrowseBot only", () => {
  const imports = read("import.uc.mjs");
  assert.match(imports, /import "\.\/findbar-ai\/index\.js"/);
  for (const name of ["command-palette", "floating-sidebar", "reopen-closed-tabs", "search-engine-select", "settings-shortcuts-search", "others/"]) {
    assert.equal(imports.includes(name), false, name);
    assert.equal(fs.existsSync(name), false, `${name} must be absent`);
  }
  assert.equal(read("userChrome.css").trim(), '@import "findbar-ai/style.css";');
  const pkg = JSON.parse(read("package.json"));
  assert.equal(Object.keys(pkg.scripts).some((key) => /palette|reopen|sidebar|select|search/.test(key)), false);
});