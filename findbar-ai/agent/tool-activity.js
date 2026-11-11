const REDACTED_KEYS = new Set(["text", "value", "typedText", "content"]);
const REDACTED_VALUE = "[redacted]";

function sensitiveArgumentValues(args) {
  if (!args || typeof args !== "object") return [];
  const values = [];
  for (const [key, value] of Object.entries(args)) {
    if (!REDACTED_KEYS.has(key) || value === null || value === undefined) continue;
    if (!["string", "number", "boolean", "bigint"].includes(typeof value)) continue;
    const text = String(value);
    if (text) values.push(text);
  }
  return values;
}

function scrubSensitiveText(text, sensitiveValues) {
  const variants = new Set();
  for (const value of sensitiveValues) {
    if (!value) continue;
    variants.add(value);
    variants.add(JSON.stringify(value).slice(1, -1));
  }
  let clean = text;
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    clean = clean.split(variant).join(REDACTED_VALUE);
  }
  return clean;
}

export function safeArgsPreview(toolName, args, limit = 300) {
  if (!args || typeof args !== "object") return "";
  const clean = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "tab" || typeof value === "function") continue;
    clean[key] = REDACTED_KEYS.has(key) ? "[redacted]" : value;
  }
  let text = "";
  try {
    text = JSON.stringify(clean);
  } catch {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function snapshotToolResult(result, limit = 1500) {
  if (result === null || result === undefined) return "";
  let text = "";
  try {
    text = typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    return "";
  }
  if (text.length > limit)
    return `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
  return text;
}

export class ToolActivity {
  #sensitiveValues = new Map();

  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.nextId = 0;
    this.entries = [];
  }

  handle(toolName, status, error = null, args = null, result = null) {
    if (status === "loading") {
      const entry = {
        id: ++this.nextId,
        tool: toolName,
        status,
        argsText: safeArgsPreview(toolName, args),
        resultText: "",
        error: null,
        startedAt: this.now(),
        endedAt: null,
        elapsedMs: 0,
      };
      this.entries.push(entry);
      this.#sensitiveValues.set(entry.id, sensitiveArgumentValues(args));
      return { ...entry };
    }
    let entry = [...this.entries].reverse().find(
      (candidate) => candidate.tool === toolName && candidate.status === "loading"
    );
    if (!entry) {
      this.handle(toolName, "loading", null, args);
      entry = this.entries[this.entries.length - 1];
    }
    const sensitiveValues = [
      ...(this.#sensitiveValues.get(entry.id) || []),
      ...sensitiveArgumentValues(args),
    ];
    entry.status = status;
    entry.error = error
      ? scrubSensitiveText(String(error?.message || error), sensitiveValues)
      : null;
    entry.resultText = entry.error
      ? `Error: ${entry.error}`
      : scrubSensitiveText(snapshotToolResult(result, Infinity), sensitiveValues);
    if (!entry.error) entry.resultText = snapshotToolResult(entry.resultText);
    entry.endedAt = this.now();
    entry.elapsedMs = Math.max(0, entry.endedAt - entry.startedAt);
    this.#sensitiveValues.delete(entry.id);
    return { ...entry };
  }

  snapshot() {
    return this.entries.map((entry) => ({ ...entry }));
  }

  clear() {
    this.entries = [];
    this.#sensitiveValues.clear();
  }
}
