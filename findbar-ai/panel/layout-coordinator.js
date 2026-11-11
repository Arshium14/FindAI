// Arc-aware layout coordination for the BrowseBot floating panel.
//
// Browser-only module (not imported by Node tests): observes the native
// findbar, expanded URL bar/results, the native sidebar, and Zen's vertical
// tab sidebar, then places the panel through Task 6's choosePanelRect.
// All notifications coalesce through one requestAnimationFrame pipeline.
//
// Invariants:
// - The panel stays position:fixed in browser chrome at the BrowseBot-owned
//   stacking level defined by #browse-bot-panel CSS. This coordinator never
//   changes position/z-index and never applies transforms to .browserStack
//   or any Arc element.
// - Layout is skipped entirely while activeGesture is true.
// - onLayout is called only when the computed rectangle differs from the
//   panel's current rectangle by at least 0.5px, which also breaks the
//   observer feedback loop from our own geometry writes.
// - When obstacles disappear, choosePanelRect naturally restores the
//   preferred corner / preferred rectangle on the next pass.

import { choosePanelRect } from "./geometry.js";

const OBSERVED_ATTRIBUTES = [
  "hidden",
  "open",
  "breakout-extend",
  "zen-sidebar-expanded",
  "zen-compact-mode",
  "zen-right-side",
  "zen-tabs-vertical-right-side",
];

const LAYOUT_EPSILON = 0.5;

export class PanelLayoutCoordinator {
  constructor(panel, callbacks = {}) {
    this.panel = panel;
    this.callbacks = callbacks;
    // Set by the owner (Task 8) from gesture start/end callbacks.
    this.activeGesture = false;
    this._started = false;
    this._frame = null;
    this._reason = "start";
    this._resizeObserver = null;
    this._mutationObserver = null;
    this._observed = new Set();
    this._onWindowResize = () => this.schedule("window-resize");
    this._tick = this._tick.bind(this);
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._resizeObserver = new ResizeObserver(() => this.schedule("resize-observer"));
    this._mutationObserver = new MutationObserver((records) => this._onMutations(records));
    // Subtree coverage catches lazily created findbars and the zen-* state
    // attributes on #main-window. "style" is deliberately not in the filter,
    // so BrowseBot panel geometry writes can never retrigger layout.
    this._mutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
      subtree: true,
    });
    window.addEventListener("resize", this._onWindowResize);
    this._observeTargets();
    this.schedule("start");
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    window.removeEventListener("resize", this._onWindowResize);
    this._resizeObserver?.disconnect();
    this._mutationObserver?.disconnect();
    this._resizeObserver = null;
    this._mutationObserver = null;
    this._observed.clear();
    if (this._frame !== null) {
      window.cancelAnimationFrame(this._frame);
      this._frame = null;
    }
  }

  // Public entry point: coalesce any number of notifications into one frame.
  schedule(reason = "schedule") {
    this._reason = reason;
    if (this._frame !== null) return;
    this._frame = window.requestAnimationFrame(this._tick);
  }

  _tick() {
    this._frame = null;
    if (!this._started) return;
    if (this.activeGesture) return; // never fight an in-flight gesture
    if (!this.panel?.isConnected) return;
    this._observeTargets();
    const rect = this._computeLayout();
    if (!rect) return;
    if (this._differsFromCurrent(rect)) {
      this.callbacks.onLayout?.(rect, { reason: this._reason });
    }
  }

  _computeLayout() {
    const preferredRect = this.callbacks.getPreferredRect?.();
    const minSize = this.callbacks.getMinSize?.();
    if (!preferredRect || !minSize) return null;
    return choosePanelRect({
      preferredRect,
      preferredCorner: this.callbacks.getPreferredCorner?.(),
      viewport: this._viewport(),
      obstacles: this.collectObstacles(),
      minSize,
    });
  }

  _differsFromCurrent(rect) {
    const current = this.panel.getBoundingClientRect();
    return (
      Math.abs(rect.x - current.x) >= LAYOUT_EPSILON ||
      Math.abs(rect.y - current.y) >= LAYOUT_EPSILON ||
      Math.abs(rect.width - current.width) >= LAYOUT_EPSILON ||
      Math.abs(rect.height - current.height) >= LAYOUT_EPSILON
    );
  }

  _viewport() {
    return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  }

  // Visible nonzero rectangles for every UI surface the panel must avoid.
  collectObstacles() {
    const candidates = [
      document.querySelector("findbar:not([hidden])"),
      document.querySelector("#urlbar[open]"),
      document.querySelector("#urlbar-results"),
      document.querySelector("#sidebar-box:not([hidden])"),
    ];
    const obstacles = [];
    let sidebarObstacleFound = false;
    for (let i = 0; i < candidates.length; i++) {
      const rect = this._visibleRect(candidates[i]);
      if (rect) {
        obstacles.push(rect);
        if (i === 3) sidebarObstacleFound = true;
      }
    }
    // Zen's vertical-tab container is not #sidebar-box; measure it only when
    // no visible native sidebar obstacle was actually collected. A hidden or
    // zero-size #sidebar-box must not suppress the Zen fallback.
    if (!sidebarObstacleFound) {
      const zenSidebar = this._zenSidebarRect();
      if (zenSidebar) obstacles.push(zenSidebar);
    }
    return obstacles;
  }

  _visibleRect(element) {
    if (!element || !element.isConnected) return null;
    if (element.getClientRects().length === 0) return null;
    const style = window.getComputedStyle(element);
    if (style.display === "none") return null;
    if (style.visibility === "hidden" || style.visibility === "collapse") return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  // Obstacle along the actual Zen sidebar edge using the measured sidebar
  // width and the main-window left/right state attributes.
  _zenSidebarRect() {
    if (typeof gZenCompactModeManager === "undefined" || !gZenCompactModeManager) return null;
    if (typeof gZenCompactModeManager.getAndApplySidebarWidth !== "function") return null;
    const mainWindow = document.getElementById("main-window");
    if (!mainWindow) return null;
    // In compact mode the vertical tabs only occupy space while expanded.
    const compact = mainWindow.getAttribute("zen-compact-mode") === "true";
    const expanded = mainWindow.getAttribute("zen-sidebar-expanded") === "true";
    if (compact && !expanded) return null;
    let width = 0;
    try {
      width = gZenCompactModeManager.getAndApplySidebarWidth();
    } catch {
      return null;
    }
    if (!Number.isFinite(width) || width <= 0) return null;
    const onRight =
      mainWindow.getAttribute("zen-tabs-vertical-right-side") === "true" ||
      mainWindow.getAttribute("zen-right-side") === "true" ||
      gZenCompactModeManager.sidebarIsOnRight === true;
    const viewport = this._viewport();
    return {
      x: onRight ? viewport.x + viewport.width - width : viewport.x,
      y: viewport.y,
      width,
      height: viewport.height,
    };
  }

  // One ResizeObserver covers the panel plus every obstacle surface. Re-run
  // each tick so lazily created elements (per-tab findbars) get observed.
  _observeTargets() {
    if (!this._resizeObserver) return;
    const targets = [
      this.panel,
      document.querySelector("findbar"),
      document.querySelector("#urlbar"),
      document.querySelector("#urlbar-results"),
      document.querySelector("#sidebar-box"),
    ];
    for (const element of targets) {
      if (!element || !element.isConnected || this._observed.has(element)) continue;
      this._resizeObserver.observe(element);
      this._observed.add(element);
    }
    // Release elements that left the document (e.g. a destroyed findbar).
    for (const element of this._observed) {
      if (!element.isConnected) {
        this._resizeObserver.unobserve(element);
        this._observed.delete(element);
      }
    }
  }

  _onMutations(records) {
    for (const record of records) {
      if (record.type !== "attributes") continue;
      // Ignore anything originating inside the BrowseBot panel (including
      // any style-attribute records): our own writes must not feed back.
      if (record.target === this.panel || this.panel.contains?.(record.target)) continue;
      this.schedule("mutation");
      return;
    }
  }
}