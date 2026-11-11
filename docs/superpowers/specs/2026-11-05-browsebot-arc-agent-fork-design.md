# BrowseBot Arc Agent Fork Design

**Date:** 2026-11-05  
**Upstream:** `BibekBhusal0/zen-custom-js`  
**Primary mod:** `findbar-ai/` (`theme.id`: `browse-bot`)

## Overview

Create a BrowseBot-only fork that preserves the current findbar, URL-bar, and Library surfaces while giving the findbar and Library a shared, more capable agent core. The floating Arc-style chat becomes persistent across tab and workspace switches, gains keyless source-gathering web research, `@` tab context, and realistic page typing tools. The fork remains directly installable through Sine and coexists with the Arc 2.0 Sine mod without UI intersections.

## Goals

- Preserve all current BrowseBot surfaces: floating findbar AI, URL-bar AI, and Library chat/agent/build modes.
- Keep one floating chat alive across tab switches, workspace switches, and repeated Ctrl+F use in other tabs.
- Let agent responses continue when the floating panel is hidden or the active tab changes.
- Provide real web research that gathers and reads sources before answering, without requiring a separate search API key.
- Support multiple `@` tab mentions in both chat surfaces.
- Let the agent inspect, click, type, and press keys in the current or a referenced tab.
- Make floating-panel resizing smooth, two-dimensional, constrained, and persistent.
- Avoid Arc 2.0's native findbar, expanded URL bar, sidebar, and stacking effects.
- Retain direct, build-free Sine installation and valid Sine metadata/preferences.
- Remove every unrelated mod from the fork.

## Non-goals

- A hosted backend, companion service, or mandatory npm runtime.
- A dedicated Tavily/Brave search credential requirement.
- Arbitrary HTML rewriting as the primary page-editing model.
- Floating-chat history persistence across browser restarts. Floating history remains session-only; existing saved Library sessions retain their current persistence behavior.
- Removing Library Build mode or URL-bar AI.

## Current-State Findings

- `findbar-ai/index.js` initializes the findbar, URL bar, and Library independently.
- `findbar-ai/findbar-ai.uc.js` rebuilds the floating UI from `updateFindbar()` on every `TabSelect`. It also aborts streaming on collapse or native findbar close.
- `findbar-ai/styles/findbar.css` targets the native `findbar` element, so Arc 2.0's own `findbar { ... !important }` rules compete for geometry and appearance.
- `findbar-ai/library/library-llm.js` already has the fullest agent loop and tool groups.
- `findbar-ai/library/library.uc.js` already implements `@` tab mentions, tab-content resolution, tool activity, confirmations, streaming, and saved sessions.
- `findbar-ai/llm/tools.js` currently implements `search` by opening a search-results URL; it does not gather sources for an answer.
- Existing page tools primarily target the selected browser and support reading, clicking, and value filling, but not a shared current-or-referenced-tab typing model.
- Arc 2.0 positions native `findbar` using `arc-findbar-*` preferences and expands its URL bar near the bottom center. Its URL-bar-open state also scales and blurs the browser stack.

## Architecture

### Shared agent core

Extract reusable behavior from the Library implementation into focused modules under `findbar-ai/`:

- **Agent controller:** owns history, provider calls, a default of 8 and hard maximum of 12 tool steps per run, cancellation, streaming, and tool callbacks.
- **Tab references:** owns the `@` token parser, searchable tab list, favicon chips, pending references, content resolution, and missing-tab behavior.
- **Tool activity model:** records tool name, arguments preview, status, elapsed time, result preview, and errors independently of either UI.
- **Web research tools:** implements search-result extraction, source reading, cleanup, and source-shaped results.
- **Page interaction tools:** implements tab-targeted inspection, clicking, typing, and key presses through the existing message-manager bridge.

The floating panel and Library supply their own rendering and session policies but use the same agent behavior. URL-bar AI retains its current scoped search, navigation, and link-opening tools; it does not gain the research loop, `@` mentions, or page typing. Library Build retains its separate build-specific tools and preview flow.

### Persistent floating panel

Create one `#browse-bot-panel` per browser window in browser chrome, outside Firefox's native `<findbar>`. The panel owns its DOM for the lifetime of the mod rather than being removed and recreated on `TabSelect`.

The native findbar remains available for ordinary text search and retains an Ask AI entry point. Ctrl+Shift+F toggles the floating agent. Ctrl+F continues to open native text search and does not close, clear, or restart the agent panel.

Tab and workspace selection changes update only the current target tab and any current-page metadata. They do not replace history, pending mentions, composer text, panel visibility, scroll position, dimensions, or the active abort controller. Hiding the panel detaches no agent state and does not abort a response; reopening reattaches the current run view and streamed result.

## Agent Behavior

The floating chat and Library agent support an explicit tool-capable mode with a default limit of 8 and a hard maximum of 12 consecutive tool steps per run. The existing unlimited `maxToolCalls = 0` behavior is migrated to the default of 8 for these agent surfaces. The model may chain search, source reading, tab reading, and page interactions before producing its final answer. Tool calls are displayed in a compact collapsible activity view rather than narrated as separate chat bubbles.

Providers that do not support tools receive a clear setup/error message when agent tools are required. Existing provider and encrypted API-key handling remains shared. The agent must not claim to have searched, read, clicked, typed, or submitted unless the corresponding tool returned successfully.

Page and search content is untrusted data. System instructions explicitly prevent page text, search snippets, or source pages from overriding agent instructions or authorizing actions.

## Keyless Web Research

### Search flow

1. Resolve the default browser search engine through the existing search-service utility.
2. Open its results URL in a temporary background tab without taking focus.
3. Extract up to 8 normalized result titles, URLs, and snippets.
4. Read up to 3 accessible, relevant sources in temporary background tabs.
5. Return source title, URL, snippet, extracted text, and any read failure to the agent.
6. Close all research-owned temporary tabs in `finally` cleanup, including cancellation and error paths.

The agent synthesizes its answer from returned content and renders clickable source links. Search result pages that require CAPTCHA, sign-in, or unsupported scripting are reported as inaccessible. Partial accessible results may be used with the limitation stated; missing information is never invented.

Research tabs are distinguished from user-opened tabs so cleanup cannot close pre-existing or reused user tabs. User-requested navigation continues to use the existing visible `openLink` behavior.

## Tab Mentions

Both chat composers support typing `@` to search open tabs across Zen workspaces. Selecting a tab inserts a title token and favicon chip; multiple mentions are allowed.

At send time, the shared resolver extracts fresh readable text from each referenced tab using its `linkedBrowser`. Mention tokens become ordinary tab titles in the visible prompt, while page content is attached as a separate context message. Existing context-length preferences limit content sent to the provider.

Closed tabs, unreadable internal pages, and empty pages produce visible warnings and a useful fallback message. Historical context blocks are hidden from the visible transcript, while the user message retains its reference chips.

## Page Interaction and Typing

Extend the content bridge so tools can address either the selected tab or a known referenced tab. Tools validate that the target tab is still connected and that the selector resolves to an appropriate element.

Supported interactions:

- Inspect visible interactive elements and relevant labels/selectors.
- Click a requested element.
- Type into inputs, textareas, and contenteditable regions, with optional clearing first.
- Press common keys such as Enter, Tab, Escape, and Backspace.
- Submit only when the user requested submission and confirmation policy allows it.

Typing focuses the target and dispatches the keyboard, before-input, input, and change events expected by ordinary web applications. Native value setters are used where necessary for controlled form frameworks. Contenteditable input uses text insertion rather than replacing arbitrary page HTML. Results include the target tab and action performed, but sensitive typed values are not echoed into activity previews.

Read-only search and inspection require no approval. State-changing actions follow BrowseBot's existing confirmation preference. Declined, timed-out, unloaded, cross-origin-restricted, and missing-target actions return explicit errors and are never presented as successful.

## Arc 2.0 Compatibility

### Selector and style isolation

The floating agent uses a unique panel ID and BrowseBot-scoped classes. It does not restyle native `findbar` geometry. Arc 2.0 therefore retains control of normal text search, while BrowseBot's chat dimensions and visibility are independent of Arc's `!important` findbar rules.

BrowseBot may consume these Arc variables as optional visual inputs, with Zen/BrowseBot fallbacks:

- `--arc-border-radius`
- `--arc-findbar-bg`
- `--arc-findbar-blur`
- `--arc-findbar-saturate`
- `--arc-findbar-contrast`

No Arc preference is written or repurposed. Internal geometry remains namespaced under BrowseBot variables.

### Collision avoidance

A layout coordinator tracks visible rectangles for the native findbar, expanded URL bar and results, the left or right tab sidebar when visible, and the browser window. Resize and mutation observations are coalesced through `requestAnimationFrame`.

The coordinator first tries the user's preferred corner. On intersection, it chooses the nearest safe candidate corner with viewport margins. When Arc's URL bar closes or native findbar disappears, the preferred position can be restored. The panel stays in browser chrome above Arc's browser-stack blur/scale effects and uses a stacking level above Arc's ordinary content overlays.

Very small viewports reduce the panel toward its minimum usable dimensions before considering any fallback position. Manual drag/resize preferences are preserved whenever they do not intersect an active obstacle.

## Cleaner UI and Efficient Resizing

The floating panel contains:

- One compact header for dragging, new chat, settings, and close.
- A message list with restrained user/assistant styling and linked sources.
- A collapsible tool-activity view.
- A reference-chip row above the composer.
- One composer with send/stop controls and `@` tab picking.

Old minimal/non-minimal native-findbar positioning branches are removed from the floating chat implementation. Settings that no longer apply are removed or migrated rather than leaving dead controls.

Resizing supports width and height from all four edges and all four corners. Pointer capture keeps the gesture active outside the handle. During a gesture, geometry is cached and style writes occur at most once per animation frame. Width and height are clamped to usable viewport bounds and active Arc collision zones. Preferences are written once at pointer-up, not on every mouse movement. Dragging uses the same coalesced event model.

## Sine Packaging and Repository Scope

The fork must run directly from source through Sine, as upstream BrowseBot and Arc 2.0 do. Preserve and validate:

- `findbar-ai/theme.json` with the `browse-bot` ID, chrome style, and `browser.xhtml` script include.
- `findbar-ai/preferences.json` and the shared preference initialization pattern.
- Relative CSS imports and Sine-compatible publishing rewrites.
- ESM source loading with no required build, backend, or npm dependency.
- Existing release bundle automation as optional release tooling only.

Remove unrelated mod directories, root imports, style imports, release targets, and documentation sections. Retain only BrowseBot, utilities it imports, necessary shared build/publish configuration, license/attribution, and BrowseBot-focused installation and usage documentation. Optional integration with an externally installed command palette may remain only through the existing no-op-safe utility; the command-palette mod itself is not included.

Update installation instructions to cover Sine explicitly and document that Arc 2.0 can remain enabled. No fx-autoconfig-only initialization is introduced.

## Error Handling and Cancellation

- Hiding the panel or changing tabs never cancels a run.
- Stop cancels the active provider request and research/page operations owned by that run.
- Every temporary research tab is cleaned up on success, failure, and abort.
- Provider failures preserve the user's prompt and show a readable error with retry/regenerate available.
- Tool errors appear in the activity view and are returned to the model without false success messages.
- Invalid or closed tab references are identified before state-changing actions.
- Panel geometry observers ignore hidden/zero-sized elements and avoid feedback loops during active pointer gestures.

## Verification

Manual verification is required in Zen Browser because the repository has no automated browser test framework. Test source installation through Sine with Arc 2.0 enabled and disabled.

### Lifecycle

- Keep the panel open while switching tabs and workspaces.
- Press Ctrl+F in multiple tabs and confirm the same chat, composer draft, and run remain intact.
- Hide the panel during streaming and confirm completion continues and reappears correctly.
- Confirm native findbar text search still works under Arc 2.0.

### Agent and context

- Ask a current-events question and verify search gathers multiple sources, opens no focused research tabs, cleans up temporary tabs, and returns working citations.
- Test a blocked/search-limited source and verify an honest partial or failure response.
- Mention multiple tabs and verify current content from each reaches the agent.
- Close a mentioned tab and verify a visible, nonfatal error.

### Interaction and safety

- Type into a conventional form and a controlled web-app input, then use Enter/Tab as requested.
- Verify declined tools perform no action and successful tools report only after completion.
- Verify page text cannot override tool-confirmation policy through injected instructions.

### Layout and packaging

- Resize horizontally and vertically during long responses without flicker or runaway preference writes.
- Open Arc's native findbar and expanded URL bar and verify the panel moves to a nonintersecting position.
- Test compact sidebar, left/right sidebar, small windows, and browser restart restoration of saved dimensions/preferences.
- Install from the fork through Sine without building and confirm all current BrowseBot surfaces initialize.
- Confirm no unrelated mod is imported, styled, or published by the fork.

## Acceptance Criteria

The work is complete when the BrowseBot-only source installs through Sine, all retained surfaces function, the floating chat survives normal tab/findbar workflows, agentic search returns source-backed answers, `@` context and page typing work in the floating chat and Library agent, resizing is smooth and persistent, Arc 2.0 UI intersections are prevented in the tested layouts, and unrelated mods are absent from repository imports and release output.
