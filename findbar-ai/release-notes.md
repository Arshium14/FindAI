# BrowseBot Arc Agent — Fork Release Notes

## New Features

- **Persistent floating panel**: One `#browse-bot-panel` per window survives tab switches, workspace switches, Ctrl+F in other tabs, and hide/reopen. Responses continue while hidden or tab changes. Floating history is session-only.
- **Shared agent core**: Floating panel and Library Agent share one AgentController with bounded steps (default 8, max 12), cancellation, streaming, and provider-neutral system override.
- **Keyless web research**: Agent searches via the browser's default search engine — no Tavily/Brave API key needed. Extracts up to 8 results, reads up to 3 sources. Temporary tabs cleaned up on success, error, and abort; user-reused tabs preserved.
- **@ tab mentions**: Mention multiple open tabs in floating and Library chat. Fresh content extracted at send time. Closed/unreadable tabs produce honest warnings.
- **Page interaction tools**: Inspect, click, type, and press keys in current or referenced tabs. Submission only when explicitly requested and confirmed. Typed values redacted from all previews, logs, and errors.
- **Eight-direction resizing**: All four edges and corners with pointer capture, rAF-coalesced geometry, persistent dimensions. Collision avoidance with native findbar and URL bar.
- **Redacted tool activity**: Shared ToolActivity model with stable entries, elapsed time, and sensitive-value scrubbing before truncation.

## Fixes

- Removed dead MINIMAL and PERSIST preferences and their settings controls.
- Removed pseudo background mode (native findbar positioning that conflicted with Arc 2.0).
- Fixed scrollbar-color invalid component-value list.
- Gated citations preference listener to avoid aborting in-flight streams.
- Old unlimited maxToolCalls=0 migrates to 8 on startup.

## Others

- **BrowseBot-only packaging**: Removed all unrelated mods (command-palette, floating-sidebar, reopen-closed-tabs, search-engine-select, search-engine-icon, compact-settings, settings-shortcuts-search, others, css). Root entries import only findbar-ai.
- **Arc 2.0 compatibility**: BrowseBot uses its own floating panel and leaves Arc's native findbar, URL bar, sidebar, and browser-stack effects under Arc's control. No Arc preferences written.
- **Direct Sine source install**: No build, backend, or npm install required. Source runs directly in the browser.
- 74 automated tests covering controller, references, activity, research, page interaction, geometry, and packaging.

# Contributors

- Bibek Bhusal — original BrowseBot creator
- BrowseBot Arc Agent fork contributors
