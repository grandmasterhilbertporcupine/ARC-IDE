type Bounds = { left: number; top: number; right: number; bottom: number };

function intersect(a: Bounds, b: Bounds): Bounds {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

function visibleBounds(element: HTMLElement, own: Bounds): Bounds {
  let visible = intersect(own, {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  });
  for (
    let ancestor = element.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const style = getComputedStyle(ancestor);
    const bounds = ancestor.getBoundingClientRect();
    if (/(hidden|clip|auto|scroll)/u.test(style.overflowX))
      visible = {
        ...visible,
        left: Math.max(visible.left, bounds.left),
        right: Math.min(visible.right, bounds.right),
      };
    if (/(hidden|clip|auto|scroll)/u.test(style.overflowY))
      visible = {
        ...visible,
        top: Math.max(visible.top, bounds.top),
        bottom: Math.min(visible.bottom, bounds.bottom),
      };
  }
  return visible;
}

function positive(bounds: Bounds): boolean {
  return bounds.right > bounds.left && bounds.bottom > bounds.top;
}

export function animateWorkspaceHandoff(
  source: HTMLElement,
  target: HTMLElement,
  eventKey: string,
  color: string,
): (() => void) | null {
  if (
    !source.isConnected ||
    !target.isConnected ||
    document.visibilityState === "hidden" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    typeof target.animate !== "function"
  )
    return null;
  const from = visibleBounds(source, source.getBoundingClientRect());
  const to = visibleBounds(target, target.getBoundingClientRect());
  if (!positive(from) || !positive(to)) return null;
  let common = source.parentElement;
  while (common && !common.contains(target)) common = common.parentElement;
  if (!common) return null;
  const commonBounds = common.getBoundingClientRect();
  const union = {
    left: Math.min(from.left, to.left),
    top: Math.min(from.top, to.top),
    right: Math.max(from.right, to.right),
    bottom: Math.max(from.bottom, to.bottom),
  };
  const clip = visibleBounds(
    common,
    positive(commonBounds) ? intersect(commonBounds, union) : union,
  );
  if (!positive(clip)) return null;
  const point = (bounds: Bounds) => ({
    x: Math.max(
      clip.left + 4,
      Math.min(
        clip.right - 4,
        bounds.left + Math.min(28, (bounds.right - bounds.left) / 2),
      ),
    ),
    y: Math.max(
      clip.top + 4,
      Math.min(
        clip.bottom - 4,
        bounds.top + Math.min(22, (bounds.bottom - bounds.top) / 2),
      ),
    ),
  });
  const start = point(from);
  const end = point(to);
  const overlay = document.createElement("div");
  overlay.dataset.workspaceHandoff = eventKey;
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "20",
    left: `${clip.left}px`,
    top: `${clip.top}px`,
    width: `${clip.right - clip.left}px`,
    height: `${clip.bottom - clip.top}px`,
    overflow: "hidden",
    contain: "strict",
  });
  const dot = document.createElement("span");
  dot.dataset.handoff = eventKey;
  Object.assign(dot.style, {
    position: "absolute",
    left: `${start.x - clip.left - 4}px`,
    top: `${start.y - clip.top - 4}px`,
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    backgroundColor: color,
  });
  overlay.appendChild(dot);
  document.body.appendChild(overlay);
  const animation = dot.animate(
    [
      { transform: "translate(0, 0)", opacity: 0 },
      { opacity: 1, offset: 0.15 },
      {
        transform: `translate(${end.x - start.x}px, ${end.y - start.y}px)`,
        opacity: 0.8,
        offset: 0.9,
      },
      {
        transform: `translate(${end.x - start.x}px, ${end.y - start.y}px)`,
        opacity: 0,
      },
    ],
    { duration: 650, easing: "cubic-bezier(.2,.6,.3,1)" },
  );
  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    animation.cancel();
    overlay.remove();
    window.removeEventListener("resize", cleanup);
    document.removeEventListener("scroll", cleanup, true);
    document.removeEventListener("visibilitychange", cleanup);
  };
  animation.onfinish = cleanup;
  window.addEventListener("resize", cleanup, { once: true });
  document.addEventListener("scroll", cleanup, { capture: true, once: true });
  document.addEventListener("visibilitychange", cleanup, { once: true });
  return cleanup;
}
