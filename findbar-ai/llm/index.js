import { streamText, generateText } from "./client.js";
import { getTools, getToolSystemPrompt, toolNameMapping } from "./tools.js";
import {
  pollinations,
  claude,
  gemini,
  grok,
  mistral,
  ollama,
  openai,
  perplexity,
  cerebras,
  deepseek,
  openrouter,
  custom,
} from "./providers.js";
import { messageManagerAPI } from "../messageManager.js";
import { getVideoContext } from "./youtube.js";
import { AgentController } from "../agent/controller.js";
import PREFS from "../utils/prefs.js";

/**
 * A base class for interacting with language models.
 * It handles provider management, history, and provides generic methods
 * for text generation, streaming, and object generation.
 */
class LLM {
  constructor() {
    this.history = [];
    this.AVAILABLE_PROVIDERS = {
      pollinations: pollinations,
      claude: claude,
      gemini: gemini,
      grok: grok,
      mistral: mistral,
      ollama: ollama,
      openai: openai,
      perplexity: perplexity,
      cerebras: cerebras,
      deepseek: deepseek,
      openrouter: openrouter,
      custom: custom,
    };
  }

  get llmProvider() {
    return PREFS.llmProvider;
  }

  get currentProvider() {
    return (
      this.AVAILABLE_PROVIDERS[this.llmProvider || "pollinations"] ||
      this.AVAILABLE_PROVIDERS["pollinations"]
    );
  }

  setProvider(providerName) {
    if (this.AVAILABLE_PROVIDERS[providerName]) {
      PREFS.llmProvider = providerName;
      PREFS.debugLog(`Switched LLM provider to: ${providerName}`);
    } else {
      PREFS.debugError(`Provider "${providerName}" not found.`);
    }
  }

  async getSystemPrompt() {
    // Base implementation. Should be overridden by extending classes.
    return "";
  }

  getSampling() {
    return {
      temperature: PREFS.llmTemperature,
      topP: PREFS.llmTopP,
      topK: PREFS.llmTopK,
      frequencyPenalty: PREFS.llmFrequencyPenalty,
      presencePenalty: PREFS.llmPresencePenalty,
      maxTokens: PREFS.llmMaxOutputTokens,
    };
  }

  async generateText(options) {
    const { prompt, tools, maxSteps, messages, abortSignal, system } = options;
    if (prompt) {
      this.history.push({ role: "user", content: prompt });
    }

    const result = await generateText({
      provider: await this.currentProvider.getModelAsync(),
      system: system ?? await this.getSystemPrompt(),
      messages: messages || this.history,
      tools,
      maxSteps: maxSteps || 1,
      sampling: this.getSampling(),
      abortSignal,
    });

    // Only update history if it wasn't overridden in the options
    if (!messages) {
      this.history.push(...result.response.messages);
    }
    return result;
  }

  async streamText(options) {
    const { prompt, onFinish, tools, maxSteps, messages, abortSignal, system } = options;
    if (prompt) {
      this.history.push({ role: "user", content: prompt });
    }

    const self = this;
    return streamText({
      provider: await this.currentProvider.getModelAsync(),
      system: system ?? await this.getSystemPrompt(),
      messages: messages || this.history,
      tools,
      maxSteps: maxSteps || 1,
      sampling: this.getSampling(),
      abortSignal,
      async onFinish(result) {
        // Only update history if it wasn't overridden in the options
        if (!messages) {
          self.history.push(...result.response.messages);
        }
        if (onFinish) onFinish(result);
      },
    });
  }

  async generateTextWithCitations(options) {
    const { prompt, messages, abortSignal } = options;
    if (prompt) {
      this.history.push({ role: "user", content: prompt });
    }

    const result = await generateText({
      provider: await this.currentProvider.getModelAsync(),
      system: await this.getSystemPrompt(),
      messages: messages || this.history,
      sampling: this.getSampling(),
      jsonMode: true,
      abortSignal,
    });

    let output;
    try {
      output = JSON.parse(result.text);
    } catch {
      output = { answer: result.text, citations: [] };
    }

    // Only update history if it wasn't overridden in the options
    if (!messages) {
      this.history.push({ role: "assistant", content: result.text });
    }
    return output;
  }

  getHistory() {
    return [...this.history];
  }

  setHistory(messages) {
    if (!Array.isArray(messages)) return;
    this.history = messages.filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        m.content !== undefined &&
        m.content !== null
    );
  }

  clearData() {
    PREFS.debugLog("Clearing LLM history and system prompt.");
    this.history = [];
  }

  getLastMessage() {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }
}

/**
 * An extended LLM class specifically for the BrowseBot floating panel.
 * It owns application-specific state (current-page context, streaming,
 * citations) and delegates every run to the shared AgentController, so the
 * floating panel and the Library Agent surface use one tool, confirmation, and
 * step-bound contract.
 */

// The floating panel gets the same tool-belt as the Library Agent surface.
const floatingAgentGroups = [
  "research",
  "navigation",
  "tabs",
  "pageInteraction",
  "youtube",
  "bookmarks",
  "workspaces",
  "uiFeedback",
];

// A bare AbortSignal is still accepted as the second argument by callers that
// predate the options object (context menu auto-send, native Ask AI).
function normalizeSendOptions(options) {
  if (!options) return {};
  if (typeof options.addEventListener === "function" && typeof options.aborted === "boolean") {
    return { abortSignal: options };
  }
  return options;
}

class BrowseBotLLM extends LLM {
  constructor() {
    super();
    this.systemInstruction = "";
    this.pageContextUrl = null;
    this.pageContextIsVideo = false;
    this._agentController = null;
  }

  get streamEnabled() {
    return PREFS.streamEnabled;
  }
  get citationsEnabled() {
    return PREFS.citationsEnabled;
  }
  get maxToolCalls() {
    return PREFS.maxToolCalls;
  }

  // One shared controller per LLM instance, mirroring the Library Agent wiring:
  // same toolkit, same PREFS-driven step bound, same confirmation contract.
  get agentController() {
    if (!this._agentController) {
      this._agentController = new AgentController(this, {
        surface: "floating",
        groups: floatingAgentGroups,
        getSystemPrompt: () => this.getSystemPrompt(),
        toolkit: { getTools, getToolSystemPrompt, toolNameMapping },
        prefs: PREFS,
      });
    }
    return this._agentController;
  }

  async updateSystemPrompt() {
    PREFS.debugLog("Updating system prompt...");
    this.systemInstruction = await this.getSystemPrompt();
  }

  // Markdown-link citations: one result shape for tool and streaming answers.
  // Current-page evidence links back to the page URL (the panel highlights the
  // quoted text on click); research sources are cited with the exact title and
  // URL a tool returned.
  getCitationInstructions() {
    const videoLine = this.pageContextIsVideo
      ? `
- **Video transcripts**: the provided content is a timestamped transcript where each line starts with its \`[mm:ss]\` time. Cite the segment time and link it to the video URL with a \`#t=mm:ss\` fragment, e.g. \`[4:30](https://www.youtube.com/watch?v=example#t=4:30)\`. Clicking it seeks the video to that moment.`
      : "";
    return `

## Citation Instructions
- Cite with ordinary Markdown links. Never answer with a JSON object.
- **Current-page evidence**: for a statement of fact supported by the current page, link a short verbatim quote from that page to the current page URL, e.g. \`[the exact quoted sentence](https://example.com/page)\`. Keep the quote short (one sentence, no line breaks) and identical to the page text, including punctuation and casing. Clicking such a link highlights the quote on the page instead of navigating.
- **Multiple sources**: repeat the link after the statement instead of merging several quotes into one link.${videoLine}
- **Research sources**: cite each source with the exact title and URL returned by the research tool, e.g. \`[Article title](https://source.example/story)\`. Never invent a title or URL that a tool did not return, and never cite a source whose result reported an error or empty text.
- **Do not cite** greetings, your own abilities, or information that came from neither the page nor a tool result.`;
  }

  async getSystemPrompt() {
    let systemPrompt = "";

    if (PREFS.findbarSystemPrompt) {
      systemPrompt = PREFS.findbarSystemPrompt + "\n\n";
    }

    systemPrompt += `You are a helpful AI assistant integrated into Zen Browser, a minimal and modern fork of Firefox. You answer questions about the current webpage and, when asked, act on the browser with tools.

## Your Instructions:
- Be concise, accurate, and helpful.
- Always answer in normal Markdown. Never reply with a JSON object and never wrap the whole answer in a code fence.`;

    if (this.citationsEnabled) {
      systemPrompt += this.getCitationInstructions();
    }

    const { url, title } = messageManagerAPI.getUrlAndTitle();
    systemPrompt += `

## Context
- The current page content arrives as a separate message in this conversation. Base page answers on that content.
- Current page: "${title}" (${url})
- If the user references tabs with @mentions, their fresh page content arrives as a separate message. Base answers about those tabs on that content.
- If the page, the referenced tabs, and your tools cannot answer the question, say so honestly instead of guessing.

## AGENTIC MODE ENABLED - TOOL USAGE:
You have access to browser functions. The user knows you have these abilities.
- Call tools silently without narrating each call. Make all the tool calls you need first, then summarize what you did and found afterwards.
- Use tools when the user explicitly asks, or when it is the only logical way to fulfill their request (e.g., "search for...").
- Prefer the current page content for page questions; reach for research only when the page cannot answer or the user asks about something beyond it.
- Only describe a search, read, click, type, key press, or submission after its tool returned success. Report tool errors, declines, and missing information honestly; never invent a tool result.
- While running tools like \`openLink\`, make sure the URL is valid.
- Batch independent creates/deletes into one call: \`createBookmark\` takes a bookmarks array, \`deleteBookmark\` takes an ids array, \`createTabFolder\` takes a names array. Never call the same create/delete tool once per item.
- When the user asks you to manage tabs (close/group/move), read the tabs first and then act instead of asking extra questions.
- If the user asks you to open a link by its text (e.g., "click the 'About Us' link"), first use \`getHTMLContent()\` to find the link's full URL, then use \`openLink()\`.
- When asked about your own abilities, describe the functions you can perform based on the tools listed below.
- **Never** mention tabId, folderId, or workspaceId to the user. Refer to tabs, folders, and workspaces by name, not id.
- Actions that need approval are asked for by the browser. A declined, timed-out, or failed action is reported as declined or failed, never as completed.`;
    return systemPrompt;
  }

  async attachPageContext() {
    const { url, title } = messageManagerAPI.getUrlAndTitle();
    const first = this.history[0];
    if (first?.pageContext && first?.contextUrl === url) {
      this.pageContextIsVideo = !!first.isVideo;
      return;
    }

    let content;
    let isVideo = false;
    const limit = PREFS.getPref(PREFS.MAX_CONTEXT_CHARS) || 0;
    try {
      const video = await getVideoContext(url, limit);
      if (video) {
        content = `Video transcript for ${url} (${title}). Each line starts with its [mm:ss] timestamp:\n\n${video.text}`;
        isVideo = true;
      }
    } catch (e) {
      PREFS.debugLog("Video transcript unavailable, falling back to page text.", e?.message);
    }
    if (!isVideo) {
      const page = await messageManagerAPI.getPageTextContent(true).catch(() => null);
      const raw = String(page?.textContent || "");
      content =
        `Webpage content for ${url} (${page?.title || title}):\n\n` +
        (limit > 0 && raw.length > limit
          ? raw.slice(0, limit) + "\n\n[Page content truncated.]"
          : raw);
    }
    const contextMsg = {
      role: "user",
      content,
      pageContext: true,
      contextUrl: url,
      ...(isVideo ? { isVideo: true } : {}),
    };
    if (first?.pageContext) this.history[0] = contextMsg;
    else this.history.unshift(contextMsg);
    this.pageContextUrl = url;
    this.pageContextIsVideo = isVideo;
  }

  // Floating send path: attach the current-page context of the tab selected at
  // send time, then delegate to the shared agent controller. This is the only
  // place page context is attached, so a TabSelect during an active run can
  // never rewrite that run's context.
  async sendMessage(prompt, options = {}) {
    const { refs, abortSignal, confirmTool, onToolStatus } = normalizeSendOptions(options);
    PREFS.debugLog("Current history before sending:", this.history);
    await this.attachPageContext();
    return this.agentController.sendMessage(prompt, {
      refs,
      abortSignal,
      confirmTool,
      onToolStatus,
    });
  }

  clearData() {
    super.clearData();
    this.systemInstruction = "";
    this.pageContextUrl = null;
    this.pageContextIsVideo = false;
  }
}

const browseBotFindbarLLM = new BrowseBotLLM();
window.browseBotFindabrLLM = browseBotFindbarLLM;
export { LLM, browseBotFindbarLLM };
