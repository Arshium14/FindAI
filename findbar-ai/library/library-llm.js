import { LLM } from "../llm/index.js";
import { getTools, getToolSystemPrompt, toolNameMapping } from "../llm/tools.js";
import { AgentController, formatTabContext } from "../agent/controller.js";
import { BUILD_NO_CONFIRM, getBuildSystemPrompt } from "./build-tools.js";
import { getStagedJS } from "./build-preview.js";
import { getInstalledMods, isBrowseBotAuthor, isUnsafeJSAllowed } from "../utils/sine-mods.js";
import { messageManagerAPI } from "../messageManager.js";
import PREFS from "../utils/prefs.js";

const MODES = ["chat", "agent", "build"];

const agentGroups = [
  "research",
  "navigation",
  "tabs",
  "pageInteraction",
  "youtube",
  "bookmarks",
  "workspaces",
  "uiFeedback",
];

const LIBRARY_BASE_PROMPT = `You are a helpful AI assistant integrated into the Zen Browser Library (BrowseBot).
Be concise, accurate, and helpful.`;

class BrowseBotLibraryLLM extends LLM {
  get mode() {
    return PREFS.libraryMode;
  }

  get isAgent() {
    return this.mode === "agent";
  }

  get isBuild() {
    return this.mode === "build";
  }

  async getSystemPrompt() {
    if (this.isAgent) return this.getAgentSystemPrompt();

    let systemPrompt = "";

    const modePrompt = PREFS.librarySystemPromptFor(this.mode);
    if (modePrompt) {
      systemPrompt = modePrompt + "\n\n";
    }

    systemPrompt += LIBRARY_BASE_PROMPT;

    if (this.isBuild) {
      systemPrompt += "\n\n" + (await getBuildSystemPrompt());
      systemPrompt += await getToolSystemPrompt(["build"]);
      return systemPrompt;
    }

    systemPrompt += `

## Chat Mode:
- You have no tools and no automatic context of the current page.
- The user can reference tabs with @mentions. Referenced tabs arrive as a separate message with their full page content.
- If the user asks you to DO something in the browser, you cannot do it in this mode. Redirect them instead of attempting it:
  - Build or style anything (Sine mods, CSS, scripts): tell them to type /build or click Build, then repeat the request there.
  - Act on the browser (manage tabs, search the web, open links, bookmarks, workspaces, page actions): tell them to type /agent or click Agent, then repeat the request there.
- When redirecting, briefly say what that mode will do for them. Never claim to have acted and never invent tool results.
- If a question cannot be answered from the conversation, say so honestly.`;

    return systemPrompt;
  }

  async getAgentSystemPrompt() {
    let systemPrompt = "";

    const modePrompt = PREFS.librarySystemPromptFor("agent");
    if (modePrompt) {
      systemPrompt = modePrompt + "\n\n";
    }

    systemPrompt += LIBRARY_BASE_PROMPT;

    const { url, title } = messageManagerAPI.getUrlAndTitle();
    systemPrompt += `

## AGENTIC MODE ENABLED - TOOL USAGE:
You have access to browser functions. The user knows you have these abilities.
- Call tools silently without narrating each call. Make all the tool calls you need first, then summarize what you did and found afterwards.
- Use tools when the user explicitly asks, or when it is the only logical way to fulfill their request (e.g., "search for...").
- When asked about your own abilities, describe the functions you can perform based on the tools listed below.
- Current page: "${title}" (${url})
- If the user references tabs with @mentions, their full page content is provided as a separate message. Base answers about those tabs on that content.
`;
    systemPrompt += `
## More instructions for Running tools
- While running tool like \`openLink\` and \`newSplit\` make sure URL is valid.
- Batch independent creates/deletes into one call: \`createBookmark\` takes a bookmarks array, \`deleteBookmark\` takes an ids array, \`createTabFolder\` takes a names array. Never call the same create/delete tool once per item.
- When user asks you to manage tabs (close/group/move tabs) do it smartly: first read tabs and take action, don't ask too many questions for confirmation.
- If the user asks you to open a link by its text (e.g., "click the 'About Us' link"), you must first use \`getHTMLContent()\` to find the link's full URL, then use \`openLink()\` to open it.
- **Never** mention tabId, folderId, or workspaceId to the user. Refer to tabs, folders, and workspaces by name, not id.`;
    return systemPrompt;
  }

  attachTabRefs(refs) {
    if (!refs || refs.length === 0) return;
    this.history.push({
      role: "user",
      content: formatTabContext(refs),
      tabContext: true,
    });
  }

  async sendMessage(prompt, { refs = [], abortSignal, confirmTool, onToolStatus } = {}) {
    PREFS.debugLog(`libraryLLM (${this.mode}): Sending prompt: "${prompt}"`);

    if (!this.isAgent && !this.isBuild) {
      this.attachTabRefs(refs);
      if (PREFS.streamEnabled) {
        return super.streamText({ prompt, abortSignal });
      }
      return super.generateText({ prompt, abortSignal });
    }

    if (this.isBuild) {
      this.attachTabRefs(refs);
      return this.sendBuildMessage(prompt, { abortSignal, confirmTool, onToolStatus });
    }

    if (!this.agentController) {
      this.agentController = new AgentController(this, {
        surface: "library",
        groups: agentGroups,
        getSystemPrompt: () => this.getAgentSystemPrompt(),
        toolkit: { getTools, getToolSystemPrompt, toolNameMapping },
        prefs: PREFS,
      });
    }
    return this.agentController.sendMessage(prompt, { refs, abortSignal, confirmTool, onToolStatus });
  }

  async sendBuildMessage(prompt, { abortSignal, confirmTool, onToolStatus } = {}) {
    const shouldToolBeCalled = async (toolName, args) => {
      if (onToolStatus) onToolStatus(toolName, "loading", null, args);
      if (BUILD_NO_CONFIRM.has(toolName)) return true;
      if (toolName === "updateModFile" && args?.modId) {
        try {
          const mods = await getInstalledMods();
          if (isBrowseBotAuthor(mods?.[args.modId]?.author)) return true;
        } catch {}
      }
      // Blocked JS still needs confirmation even with confirmations off.
      let unsafeJSBlocked = false;
      if (toolName === "createMod") {
        try {
          unsafeJSBlocked =
            String(args?.js ?? getStagedJS() ?? "").trim().length > 0 && !isUnsafeJSAllowed();
        } catch {}
      }
      if (!PREFS.confirmation && !unsafeJSBlocked) return true;
      const friendlyName = toolNameMapping[toolName] || toolName;
      const confirmed = confirmTool
        ? await confirmTool([friendlyName], { toolName, args, unsafeJSBlocked })
        : true;
      if (!confirmed) {
        PREFS.debugLog(`Build tool '${toolName}' declined by user.`);
        if (onToolStatus) onToolStatus(toolName, "declined", null, args);
        return false;
      }
      return true;
    };

    const afterToolCall = (toolName, result, args) => {
      if (onToolStatus)
        onToolStatus(toolName, result?.error ? "error" : "success", result?.error, args, result);
    };

    const tools = getTools(["build"], { shouldToolBeCalled, afterToolCall });

    const commonConfig = {
      prompt,
      tools,
      maxSteps: PREFS.maxToolCalls > 0 ? PREFS.maxToolCalls : Infinity,
      abortSignal,
    };

    if (PREFS.streamEnabled) {
      return super.streamText(commonConfig);
    }
    return super.generateText(commonConfig);
  }
}

export { BrowseBotLibraryLLM, MODES };

const browseBotLibraryLLM = new BrowseBotLibraryLLM();
window.browseBotLibraryLLM = browseBotLibraryLLM;
export { browseBotLibraryLLM };
