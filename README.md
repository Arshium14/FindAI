# BrowseBot Arc Agent

A BrowseBot-focused fork of BibekBhusal0/zen-custom-js. It preserves the floating AI, URL-bar AI, and Zen Library chat/agent/build surfaces.

## Install with Sine

1. Install Sine in Zen Browser.
2. Add this repository as a Sine mod repository and install **BrowseBot Arc Agent**.
3. Restart Zen when Sine requests it. No build, backend, npm install, or search API key is required.
4. Configure the LLM provider/model and its API key in BrowseBot settings. Web research itself uses the browser's default search engine and needs no separate search key.

Arc 2.0 may remain enabled. BrowseBot uses its own floating panel and leaves Arc's native findbar, URL bar, sidebar, and browser-stack effects under Arc's control.

## Use

- **Ctrl+F:** ordinary native text search; Ask AI opens the floating agent.
- **Ctrl+Shift+F:** show/hide the persistent floating agent.
- **URL-bar AI:** existing scoped search/navigation/link opening.
- **Library:** Chat, Agent, and Build modes with saved Library sessions.
- **@:** mention one or more open tabs in floating or Library chat; fresh text is read at send time.
- **Stop:** cancels the active provider request and research/page operations. Hiding the panel or changing tabs does not cancel.

Floating history lasts for the browser session. Library sessions retain their existing persistence.

## Agent capabilities

### Web research (keyless)

The agent searches the internet using the browser's default search engine — no Tavily, Brave, or other search API key is needed. Research opens temporary background tabs, extracts up to 8 search results, and reads up to 3 sources. Every research-owned tab is cleaned up on success, error, and abort. Tabs reused or selected by the user are never closed.

### Page interaction

The agent can inspect page elements, click, type, and press keys in the current or a referenced tab. Typing and submission are state-changing actions that follow BrowseBot's confirmation preference. Read-only inspection needs no approval. Typed values never appear in activity previews, logs, or errors.

### Tool confirmations

Read-only research and inspection run without approval. State-changing actions (click, type, key press, submit) follow the "Confirm before tool call" preference. Declined, timed-out, or failed actions return explicit errors and are never presented as successful. The agent never claims to have searched, read, clicked, typed, or submitted unless the tool returned successfully.

### Agent limits

- Default: 8 tool-call steps per run.
- Hard maximum: 12 steps.
- The old unlimited setting (`maxToolCalls=0`) migrates to 8 on startup.

### Resizing

The floating panel supports eight-direction resizing (all four edges and all four corners) with pointer capture and rAF-coalesced geometry writes. Dimensions persist across restarts when "Remember Dimensions" is enabled. The panel avoids colliding with the native findbar and URL bar.

## LLM providers

Works out of the box with Pollinations AI (free, no key required). Also supports Anthropic Claude, Google Gemini, xAI Grok, Mistral AI, OpenAI, Cerebras, DeepSeek, OpenRouter, Perplexity, Ollama (local), and any OpenAI-compatible custom endpoint. Configure the provider, model, and API key in BrowseBot settings.

## Manual verification matrix

After installing, verify in Zen Browser:

- [ ] Floating panel persists across tab switches, workspace switches, and Ctrl+F in another tab.
- [ ] Hiding and reopening the panel does not reset the conversation or cancel an in-flight response.
- [ ] @-mentioning multiple tabs reads fresh content at send time.
- [ ] Web research opens and cleans up temporary tabs; results are honest about failures.
- [ ] Page interaction tools require confirmation for writes; typed values are redacted.
- [ ] Eight-direction resizing works; dimensions survive restart.
- [ ] Arc 2.0 native findbar, URL bar, and sidebar are unaffected.
- [ ] Library Chat/Agent/Build modes work with saved sessions.
- [ ] No Arc preferences are written in `about:config`.

## License

MIT — see [LICENSE](LICENSE) for details. Original work by Bibek Bhusal.
