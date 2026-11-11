// Pointer-captured drag/resize gestures for the BrowseBot floating panel.
//
// This module has two layers:
//   1. Pure helpers (createFrameCoalescer, GestureSession) with no DOM or
//      Firefox globals, so Node can import this file directly for tests.
//   2. PanelGestures, a browser adapter that touches window/document/panel
//      only inside method bodies that run in the browser. Importing this
//      module in plain Node never executes those bodies.
//
// Rectangles are derived exclusively through Task 6's dragRect/resizeRect;
// this layer never re-implements geometry.

import { dragRect, resizeRect } from "./geometry.js";

// Coalesce many updates into a single write of the latest value per frame.
// schedule(fn) -> id, cancel(id), write(value) are injected so the behavior is
// deterministic under a fake scheduler in tests.
export function createFrameCoalescer(schedule, cancel, write) {
  let pending = null;
  let latest;
  const flush = () => {
    if (pending !== null) cancel(pending);
    pending = null;
    write(latest);
  };
  return {
    update(value) {
      latest = value;
      if (pending !== null) return;
      pending = schedule(() => {
        pending = null;
        write(latest);
      });
    },
    flush,
    cancel() {
      if (pending !== null) cancel(pending);
      pending = null;
    },
  };
}

// One drag/resize gesture: start(rect), update(rect) per pointer move, and
// finish() at pointer-up. finish() flushes the latest geometry once and
// persists once; a second finish() is a no-op returning null.
export class GestureSession {
  constructor({ coalescer, onPersist }) {
    this.coalescer = coalescer;
    this.onPersist = onPersist;
    this.active = false;
  }
  start(rect) {
    this.latest = rect;
    this.active = true;
  }
  update(rect) {
    if (!this.active) return;
    this.latest = rect;
    this.coalescer.update(rect);
  }
  finish() {
    if (!this.active) return null;
    this.active = false;
    this.coalescer.flush();
    this.onPersist(this.latest);
    return this.latest;
  }
}

// Browser adapter. Consumes a panel with eight [data-resize] handles and one
// [data-drag-handle] header. Uses pointer capture so the gesture stays active
// outside the handle; never registers document mousemove handlers. During a
// gesture it writes only style.left/top/width/height (no preference setters,
// no panel rebuilds) and fires exactly one end callback at pointer-up.
export class PanelGestures {
  constructor(panel, callbacks = {}) {
    this.panel = panel;
    this.callbacks = callbacks;
    this._mode = null; // "drag" | "resize"
    this._handle = null; // resize handle name (n/s/e/w/ne/nw/se/sw)
    this._pointerId = null;
    this._startPointer = null; // { x, y } in client coordinates
    this._startRect = null; // { x, y, width, height }
    this._viewport = null;
    this._minSize = null;
    this._attached = false;

    this._coalescer = createFrameCoalescer(
      (fn) => window.requestAnimationFrame(fn),
      (id) => window.cancelAnimationFrame(id),
      (rect) => this._writeGeometry(rect),
    );
    this._session = new GestureSession({
      coalescer: this._coalescer,
      onPersist: (rect) => this._persist(rect),
    });

    // Bind once so add/removeEventListener reference the same function.
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);
    this._onLostPointerCapture = this._onLostPointerCapture.bind(this);
  }

  // True while a drag/resize gesture is in flight. The layout coordinator
  // reads this (via Task 8 wiring) to skip layout during gestures.
  get active() {
    return this._session.active;
  }

  attach() {
    if (this._attached) return;
    this._attached = true;
    const panel = this.panel;
    panel.addEventListener("pointerdown", this._onPointerDown);
    panel.addEventListener("pointermove", this._onPointerMove);
    panel.addEventListener("pointerup", this._onPointerUp);
    panel.addEventListener("pointercancel", this._onPointerCancel);
    panel.addEventListener("lostpointercapture", this._onLostPointerCapture);
  }

  detach() {
    if (!this._attached) return;
    this._attached = false;
    const panel = this.panel;
    panel.removeEventListener("pointerdown", this._onPointerDown);
    panel.removeEventListener("pointermove", this._onPointerMove);
    panel.removeEventListener("pointerup", this._onPointerUp);
    panel.removeEventListener("pointercancel", this._onPointerCancel);
    panel.removeEventListener("lostpointercapture", this._onLostPointerCapture);
    // End any in-flight gesture cleanly so persistence is not lost.
    this._endGesture();
    this._coalescer.cancel();
  }

  _onPointerDown(event) {
    if (event.button !== 0) return; // primary button only
    if (this._session.active) return; // ignore a second concurrent pointer
    const target = event.target;
    const resizeHandle = target.closest?.("[data-resize]");
    const dragHandle = target.closest?.("[data-drag-handle]");
    let mode;
    let handle = null;
    if (resizeHandle) {
      mode = "resize";
      handle = resizeHandle.getAttribute("data-resize");
    } else if (dragHandle) {
      mode = "drag";
    } else {
      return;
    }
    // Never start a drag from an interactive child of the header. Task 8
    // stops propagation on action buttons; this is a defensive guard.
    if (mode === "drag" && target.closest?.("button, input, textarea, select, a")) {
      return;
    }

    event.preventDefault();
    this._mode = mode;
    this._handle = handle;
    this._pointerId = event.pointerId;
    this._startPointer = { x: event.clientX, y: event.clientY };
    this._startRect = this._readRect();
    this._viewport = this._readViewport();
    this._minSize = this._readMinSize();

    // Capture on the panel so move/up retarget here even outside the handle.
    this.panel.setPointerCapture?.(event.pointerId);

    if (mode === "drag") this.callbacks.onDragStart?.(this._startRect);
    else this.callbacks.onResizeStart?.(this._startRect);

    this._session.start(this._startRect);
  }

  _onPointerMove(event) {
    if (!this._session.active) return;
    if (event.pointerId !== this._pointerId) return;
    const dx = event.clientX - this._startPointer.x;
    const dy = event.clientY - this._startPointer.y;
    // resizeRect anchors the opposite edge against minSize only; a later
    // viewport clamp may shift position (e.g. a west resize hitting the left
    // margin slides the east edge). That is inherent to resizeRect, so we
    // pass minSize through and never re-implement the anchoring here.
    const rect =
      this._mode === "drag"
        ? dragRect(this._startRect, dx, dy, this._viewport)
        : resizeRect(this._startRect, this._handle, dx, dy, this._viewport, this._minSize);
    this._session.update(rect);
  }

  _onPointerUp(event) {
    if (event.pointerId !== this._pointerId) return;
    this._endGesture();
  }

  _onPointerCancel(event) {
    if (event.pointerId !== this._pointerId) return;
    this._endGesture();
  }

  _onLostPointerCapture(event) {
    if (event.pointerId !== this._pointerId) return;
    this._endGesture();
  }

  _endGesture() {
    if (!this._session.active) return null;
    const pointerId = this._pointerId;
    // finish() flushes the latest geometry once and persists once, firing
    // exactly one of onDragEnd/onResizeEnd via _persist.
    const rect = this._session.finish();
    this._mode = null;
    this._handle = null;
    this._pointerId = null;
    this._startPointer = null;
    this._startRect = null;
    this._viewport = null;
    this._minSize = null;
    if (pointerId !== null && this.panel.hasPointerCapture?.(pointerId)) {
      this.panel.releasePointerCapture(pointerId);
    }
    return rect;
  }

  _persist(rect) {
    if (this._mode === "drag") this.callbacks.onDragEnd?.(rect);
    else if (this._mode === "resize") this.callbacks.onResizeEnd?.(rect);
  }

  // The coalesced write: only geometry style properties, then onChange.
  _writeGeometry(rect) {
    if (!rect) return;
    const style = this.panel.style;
    style.left = `${rect.x}px`;
    style.top = `${rect.y}px`;
    style.width = `${rect.width}px`;
    style.height = `${rect.height}px`;
    this.callbacks.onChange?.(rect);
  }

  _readRect() {
    const rect = this.panel.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }

  _readViewport() {
    return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  }

  _readMinSize() {
    const style = window.getComputedStyle(this.panel);
    return {
      width: parseFloat(style.minWidth) || 0,
      height: parseFloat(style.minHeight) || 0,
    };
  }
}