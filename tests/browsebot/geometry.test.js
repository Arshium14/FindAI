import test from "node:test";
import assert from "node:assert/strict";
import { choosePanelRect, cornerRect, dragRect, intersects, resizeRect } from "../../findbar-ai/panel/geometry.js";
import { createFrameCoalescer, GestureSession } from "../../findbar-ai/panel/gestures.js";

const viewport = { x: 0, y: 0, width: 1000, height: 800 };
const start = { x: 400, y: 300, width: 300, height: 200 };
const minSize = { width: 200, height: 100 };

test("all eight resize handles adjust the correct edges", () => {
  assert.deepEqual(resizeRect({ ...start, width: 400 }, "e", 50, 0, viewport, minSize), { x: 400, y: 300, width: 450, height: 200 });
  assert.deepEqual(resizeRect({ ...start, width: 400 }, "w", 50, 0, viewport, minSize), { x: 450, y: 300, width: 350, height: 200 });
  assert.deepEqual(resizeRect({ ...start, width: 400 }, "s", 0, 50, viewport, minSize), { x: 400, y: 300, width: 400, height: 250 });
  assert.deepEqual(resizeRect({ ...start, width: 400 }, "n", 0, 50, viewport, minSize), { x: 400, y: 350, width: 400, height: 150 });
  assert.equal(resizeRect({ ...start, width: 400 }, "ne", 20, 20, viewport, minSize).width, 420);
  assert.equal(resizeRect({ ...start, width: 400 }, "nw", 20, 20, viewport, minSize).x, 420);
  assert.equal(resizeRect({ ...start, width: 400 }, "se", 20, 20, viewport, minSize).height, 220);
  assert.equal(resizeRect({ ...start, width: 400 }, "sw", 20, 20, viewport, minSize).x, 420);
});

test("resize clamps to viewport and minimum dimensions", () => {
  const resized = resizeRect(start, "nw", 900, 700, viewport, minSize);
  assert.equal(resized.width, minSize.width);
  assert.equal(resized.height, minSize.height);
  assert.equal(resized.x, start.x + start.width - minSize.width);
  assert.equal(resized.y, start.y + start.height - minSize.height);
});

test("drag stays within viewport margins", () => {
  assert.deepEqual(dragRect(start, -1000, -1000, viewport), { x: 16, y: 16, width: 300, height: 200 });
  assert.deepEqual(dragRect(start, 1000, 1000, viewport), { x: 684, y: 584, width: 300, height: 200 });
});

test("collision chooses nearest safe corner and restores preferred when clear", () => {
  const preferredRect = { x: 604, y: 16, width: 380, height: 300 };
  const obstacle = { x: 550, y: 0, width: 450, height: 380 };
  assert.equal(intersects(preferredRect, obstacle), true);
  const moved = choosePanelRect({ preferredRect, preferredCorner: "top-right", viewport, obstacles: [obstacle], minSize });
  assert.equal(intersects(moved, obstacle), false);
  const restored = choosePanelRect({ preferredRect, preferredCorner: "top-right", viewport, obstacles: [], minSize });
  assert.deepEqual(restored, preferredRect);
});

test("zero-sized obstacles are ignored and tiny viewports keep the panel usable", () => {
  const tiny = { x: 0, y: 0, width: 250, height: 180 };
  const rect = choosePanelRect({
    preferredRect: { x: 200, y: 150, width: 400, height: 300 },
    preferredCorner: "bottom-right",
    viewport: tiny,
    obstacles: [{ x: 0, y: 0, width: 0, height: 100 }],
    minSize,
  });
  assert.equal(rect.x >= 16 && rect.y >= 16, true);
  assert.equal(rect.x + rect.width <= 234 && rect.y + rect.height <= 164, true);
  assert.equal(rect.width >= minSize.width && rect.height >= minSize.height, true);
});

test("collision candidate avoids both native findbar and URL-bar rectangles", () => {
  const nativeFindbar = { x: 550, y: 0, width: 450, height: 120 };
  const urlbar = { x: 200, y: 0, width: 600, height: 80 };
  const moved = choosePanelRect({
    preferredRect: { x: 604, y: 16, width: 380, height: 300 },
    preferredCorner: "top-right",
    viewport,
    obstacles: [nativeFindbar, urlbar],
    minSize,
  });
  assert.equal(intersects(moved, nativeFindbar), false);
  assert.equal(intersects(moved, urlbar), false);
});

test("frame coalescer writes only the latest geometry once per frame", () => {
  let callback = null;
  const writes = [];
  const coalescer = createFrameCoalescer((fn) => { callback = fn; return 1; }, () => {}, writes.push.bind(writes));
  coalescer.update({ x: 1 });
  coalescer.update({ x: 2 });
  assert.equal(writes.length, 0);
  callback();
  assert.deepEqual(writes, [{ x: 2 }]);
});

test("gesture persistence flushes once at pointer-up with the latest rectangle", () => {
  let callback = null;
  const writes = [];
  const persisted = [];
  const coalescer = createFrameCoalescer((fn) => { callback = fn; return 1; }, () => {}, writes.push.bind(writes));
  const session = new GestureSession({ coalescer, onPersist: (rect) => persisted.push(rect) });
  session.start({ x: 10, y: 20, width: 300, height: 200 });
  for (let move = 1; move <= 20; move += 1) {
    session.update({ x: 10 + move, y: 20, width: 300, height: 200 });
  }
  assert.equal(writes.length, 0);
  assert.equal(persisted.length, 0);
  session.finish();
  assert.deepEqual(writes, [{ x: 30, y: 20, width: 300, height: 200 }]);
  assert.deepEqual(persisted, [{ x: 30, y: 20, width: 300, height: 200 }]);
  session.finish();
  assert.equal(persisted.length, 1);
});

test("collision shrinks in 40px steps when every corner is blocked at the preferred size", () => {
  const preferredRect = { x: 584, y: 16, width: 400, height: 300 };
  const obstacle = { x: 300, y: 200, width: 400, height: 400 };
  // At the preferred size all four corner candidates intersect the obstacle,
  // so choosePanelRect must shrink toward minSize in 40px increments to clear.
  for (const corner of ["top-left", "top-right", "bottom-left", "bottom-right"]) {
    assert.equal(intersects(cornerRect({ width: 400, height: 300 }, corner, viewport), obstacle), true);
  }
  const shrunk = choosePanelRect({ preferredRect, preferredCorner: "top-right", viewport, obstacles: [obstacle], minSize });
  assert.equal(intersects(shrunk, obstacle), false);
  // 400x300 -> 360x260 -> 320x220 -> 280x180 clears at the preferred corner.
  assert.deepEqual(shrunk, { x: 704, y: 16, width: 280, height: 180 });
});

test("collision falls back to the smallest-intersection corner when no candidate clears", () => {
  const preferredRect = { x: 584, y: 16, width: 400, height: 300 };
  // One obstacle pinned to each corner keeps every candidate blocked at every
  // size down to minSize, so no clear candidate exists and the last-resort
  // smallest-total-intersection-area fallback must run.
  const obstacles = [
    { x: 0, y: 0, width: 116, height: 116 },
    { x: 884, y: 0, width: 116, height: 66 },
    { x: 0, y: 684, width: 46, height: 116 },
    { x: 934, y: 734, width: 66, height: 66 },
  ];
  const rect = choosePanelRect({ preferredRect, preferredCorner: "top-right", viewport, obstacles, minSize });
  // Bottom-right has the smallest intersection area (2500) at minSize and is
  // returned clamped, fully on-screen, still overlapping an obstacle.
  assert.deepEqual(rect, cornerRect(minSize, "bottom-right", viewport));
  assert.equal(rect.x >= 16 && rect.y >= 16, true);
  assert.equal(rect.x + rect.width <= 984 && rect.y + rect.height <= 784, true);
  assert.equal(obstacles.some((obstacle) => intersects(rect, obstacle)), true);
});
