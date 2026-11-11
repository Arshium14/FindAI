// Pure panel geometry for the BrowseBot floating panel.
// Rectangles are plain { x, y, width, height } objects. This module has no
// DOM or Firefox globals so every calculation is deterministic and
// Node-testable. Hidden obstacles are filtered by the browser layout
// coordinator before rectangles reach these functions.

const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"];
const SHRINK_STEP = 40;

// Half-open rectangles: touching edges do not count as intersection.
export function intersects(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

// Keep a rectangle inside the viewport margins while honoring minSize.
// When the viewport itself is smaller than minSize, staying on-screen wins.
export function clampRect(rect, viewport, minSize, margin = 16) {
  const availableWidth = Math.max(0, viewport.width - margin * 2);
  const availableHeight = Math.max(0, viewport.height - margin * 2);
  const width = Math.min(Math.max(rect.width, minSize.width), availableWidth);
  const height = Math.min(Math.max(rect.height, minSize.height), availableHeight);
  const minX = viewport.x + margin;
  const minY = viewport.y + margin;
  const maxX = Math.max(minX, viewport.x + viewport.width - margin - width);
  const maxY = Math.max(minY, viewport.y + viewport.height - margin - height);
  return {
    x: Math.min(Math.max(rect.x, minX), maxX),
    y: Math.min(Math.max(rect.y, minY), maxY),
    width,
    height,
  };
}

// Place a size at one of the four viewport corners, inset by margin.
export function cornerRect(size, corner, viewport, margin = 16) {
  const x = corner.endsWith("left")
    ? viewport.x + margin
    : viewport.x + viewport.width - margin - size.width;
  const y = corner.startsWith("top")
    ? viewport.y + margin
    : viewport.y + viewport.height - margin - size.height;
  return { x, y, width: size.width, height: size.height };
}

// Resize by a handle (n/s/e/w/ne/nw/se/sw). The moving edges follow the
// pointer delta; when shrinking would cross minSize, the moving edge stops
// so the opposite edge stays fixed. The result is clamped to the viewport.
// Note for gesture consumers: opposite-edge anchoring is against minSize
// only, not against the viewport clamp — the subsequent clamp can still
// shift position (e.g. the east edge slides when a west resize hits the
// left margin). Derive gesture rectangles through this function instead of
// re-implementing the anchoring.
export function resizeRect(start, handle, dx, dy, viewport, minSize, margin = 16) {
  const name = typeof handle === "string" ? handle.toLowerCase() : "";
  const movesWest = name.includes("w");
  const movesEast = name.includes("e");
  const movesNorth = name.includes("n");
  const movesSouth = name.includes("s");

  let left = start.x + (movesWest ? dx : 0);
  let right = start.x + start.width + (movesEast ? dx : 0);
  let top = start.y + (movesNorth ? dy : 0);
  let bottom = start.y + start.height + (movesSouth ? dy : 0);

  if (right - left < minSize.width) {
    if (movesWest) left = right - minSize.width;
    else if (movesEast) right = left + minSize.width;
  }
  if (bottom - top < minSize.height) {
    if (movesNorth) top = bottom - minSize.height;
    else if (movesSouth) bottom = top + minSize.height;
  }

  return clampRect(
    { x: left, y: top, width: right - left, height: bottom - top },
    viewport,
    minSize,
    margin,
  );
}

// Translate a rectangle by a pointer delta, keeping it inside the margins.
export function dragRect(start, dx, dy, viewport, margin = 16) {
  return clampRect(
    { x: start.x + dx, y: start.y + dy, width: start.width, height: start.height },
    viewport,
    { width: start.width, height: start.height },
    margin,
  );
}

function centerDistanceSq(rect, center) {
  const cx = rect.x + rect.width / 2 - center.x;
  const cy = rect.y + rect.height / 2 - center.y;
  return cx * cx + cy * cy;
}

function intersectionArea(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

// Pick an on-screen panel rectangle that avoids obstacles. Candidates are
// the four viewport corners: preferred corner first, then the remaining
// corners ordered by distance from the preferred rectangle's center. If no
// candidate fits at the current size, shrink toward minSize in 40px steps
// and retry. As a last resort, return the clamped candidate with the
// smallest total intersection area — never an off-screen rectangle.
export function choosePanelRect({
  preferredRect,
  preferredCorner,
  viewport,
  obstacles = [],
  minSize,
  margin = 16,
}) {
  const corner = CORNERS.includes(preferredCorner) ? preferredCorner : "top-right";
  const solidObstacles = obstacles.filter(
    (obstacle) => obstacle && obstacle.width > 0 && obstacle.height > 0,
  );
  const center = {
    x: preferredRect.x + preferredRect.width / 2,
    y: preferredRect.y + preferredRect.height / 2,
  };

  const candidatesFor = (width, height) => {
    const size = { width, height };
    const others = CORNERS.filter((name) => name !== corner)
      .map((name) => cornerRect(size, name, viewport, margin))
      .sort((a, b) => centerDistanceSq(a, center) - centerDistanceSq(b, center));
    return [cornerRect(size, corner, viewport, margin), ...others];
  };

  let width = Math.max(preferredRect.width, minSize.width);
  let height = Math.max(preferredRect.height, minSize.height);
  let candidates;
  for (;;) {
    candidates = candidatesFor(width, height);
    const fits =
      width <= viewport.width - margin * 2 && height <= viewport.height - margin * 2;
    if (fits) {
      const clear = candidates.find(
        (rect) => !solidObstacles.some((obstacle) => intersects(rect, obstacle)),
      );
      if (clear) return clear;
    }
    if (width === minSize.width && height === minSize.height) break;
    width = Math.max(minSize.width, width - SHRINK_STEP);
    height = Math.max(minSize.height, height - SHRINK_STEP);
  }

  let best = null;
  let bestArea = Infinity;
  for (const candidate of candidates) {
    const rect = clampRect(candidate, viewport, minSize, margin);
    const area = solidObstacles.reduce(
      (total, obstacle) => total + intersectionArea(rect, obstacle),
      0,
    );
    if (area < bestArea) {
      best = rect;
      bestArea = area;
    }
  }
  return best;
}