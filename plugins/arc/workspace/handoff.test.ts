// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { animateWorkspaceHandoff } from "./handoff.js";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function scene() {
  const outer = document.createElement("div");
  outer.style.overflowX = "hidden";
  outer.style.overflowY = "hidden";
  const shared = document.createElement("div");
  const source = document.createElement("section");
  const target = document.createElement("section");
  shared.append(source, target);
  outer.append(shared);
  document.body.append(outer);
  vi.spyOn(outer, "getBoundingClientRect").mockReturnValue(
    new DOMRect(100, 100, 700, 500),
  );
  vi.spyOn(shared, "getBoundingClientRect").mockReturnValue(
    new DOMRect(50, 50, 900, 650),
  );
  vi.spyOn(source, "getBoundingClientRect").mockReturnValue(
    new DOMRect(50, 50, 400, 650),
  );
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(
    new DOMRect(500, 50, 450, 650),
  );
  const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null };
  const animate = vi.fn(
    (_frames: Keyframe[], _options: KeyframeAnimationOptions) => animation,
  );
  const original = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "animate",
  );
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: animate,
  });
  const restore = () => {
    if (original) Object.defineProperty(Element.prototype, "animate", original);
    else Reflect.deleteProperty(Element.prototype, "animate");
  };
  return { source, target, animation, animate, restore };
}

describe("recorded handoff geometry", () => {
  it("clips the cross-pane overlay to visible ancestors and cancels its viewport coordinates on scroll", () => {
    const s = scene();
    try {
      const cleanup = animateWorkspaceHandoff(
        s.source,
        s.target,
        "accepted-key",
        "rgb(20, 80, 200)",
      );
      const overlay = document.querySelector<HTMLElement>(
        "[data-workspace-handoff]",
      );
      expect(overlay?.style).toMatchObject({
        left: "100px",
        top: "100px",
        width: "700px",
        height: "500px",
        overflow: "hidden",
      });
      expect(s.animate.mock.calls[0][0]).toContainEqual({
        transform: "translate(400px, 0px)",
        opacity: 0,
      });
      document.dispatchEvent(new Event("scroll"));
      expect(document.querySelector("[data-workspace-handoff]")).toBeNull();
      expect(s.animation.cancel).toHaveBeenCalledTimes(1);
      cleanup?.();
      expect(s.animation.cancel).toHaveBeenCalledTimes(1);
    } finally {
      s.restore();
    }
  });

  it("does not manufacture motion for hidden, detached or reduced-motion source panes", () => {
    const s = scene();
    try {
      vi.stubGlobal("matchMedia", () => ({ matches: true }));
      expect(
        animateWorkspaceHandoff(s.source, s.target, "key", "red"),
      ).toBeNull();
      vi.stubGlobal("matchMedia", () => ({ matches: false }));
      vi.mocked(s.source.getBoundingClientRect).mockReturnValue(new DOMRect());
      expect(
        animateWorkspaceHandoff(s.source, s.target, "key", "red"),
      ).toBeNull();
      s.source.remove();
      expect(
        animateWorkspaceHandoff(s.source, s.target, "key", "red"),
      ).toBeNull();
      expect(s.animate).not.toHaveBeenCalled();
    } finally {
      s.restore();
    }
  });
});
