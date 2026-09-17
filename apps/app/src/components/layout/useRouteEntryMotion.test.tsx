// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRouteEntryMotion } from "./useRouteEntryMotion";

const originalAnimate = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "animate",
);
const animations: { cancel: ReturnType<typeof vi.fn> }[] = [];
const animate = vi.fn(() => {
  const animation = { cancel: vi.fn() };
  animations.push(animation);
  return animation;
});
let reducedMotion = false;
let preferenceEvents: EventTarget;
let motionStyle: CSSStyleDeclaration;

function RouteContent({
  pathname,
  streamedText = "",
}: {
  pathname: string;
  streamedText?: string;
}) {
  const target = useRef<HTMLElement>(null);
  useRouteEntryMotion(target, pathname);
  return (
    <main ref={target} data-testid="content">
      <textarea aria-label="Editor" defaultValue="persistent source" />
      <output>
        {pathname}
        {streamedText}
      </output>
    </main>
  );
}

beforeEach(() => {
  reducedMotion = false;
  preferenceEvents = new EventTarget();
  animations.length = 0;
  animate.mockClear();
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    get matches() {
      return reducedMotion;
    },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: preferenceEvents.addEventListener.bind(preferenceEvents),
    removeEventListener:
      preferenceEvents.removeEventListener.bind(preferenceEvents),
    dispatchEvent: preferenceEvents.dispatchEvent.bind(preferenceEvents),
  }));
  motionStyle = document.createElement("div").style;
  motionStyle.setProperty("--arc-motion-enter", "0.16s");
  motionStyle.setProperty("--arc-motion-ease", "cubic-bezier(0.2, 0, 0, 1)");
  vi.spyOn(window, "getComputedStyle").mockReturnValue(motionStyle);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalAnimate) {
    Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "animate");
  }
});

it("enters on route changes without replaying on streaming or replacing focused content", () => {
  const { rerender } = render(<RouteContent pathname="/first" />);
  const editor = screen.getByRole("textbox", { name: "Editor" });
  if (!(editor instanceof HTMLTextAreaElement))
    throw new Error("Missing editor");
  editor.focus();
  fireEvent.change(editor, { target: { value: "unsaved edit" } });
  editor.setSelectionRange(2, 5);
  const content = screen.getByTestId("content");
  content.scrollTop = 40;
  expect(animate).toHaveBeenCalledWith([{ opacity: 0.94 }, { opacity: 1 }], {
    duration: 160,
    easing: "cubic-bezier(0.2, 0, 0, 1)",
  });
  const styleReads = vi.mocked(window.getComputedStyle).mock.calls.length;
  rerender(<RouteContent pathname="/first" streamedText="stream update" />);
  fireEvent.resize(window);
  expect(animate).toHaveBeenCalledTimes(1);
  expect(window.getComputedStyle).toHaveBeenCalledTimes(styleReads);
  rerender(<RouteContent pathname="/second" streamedText="stream update" />);
  expect(animate).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("textbox", { name: "Editor" })).toBe(editor);
  expect(document.activeElement).toBe(editor);
  expect(editor.value).toBe("unsaved edit");
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 5]);
  expect(content.scrollTop).toBe(40);
});

it("cancels superseded entries, active reduced-motion changes, and unmounts", () => {
  const { rerender, unmount } = render(<RouteContent pathname="/first" />);
  rerender(<RouteContent pathname="/second" />);
  expect(animations[0]?.cancel).toHaveBeenCalledTimes(1);
  expect(animations[0]?.cancel.mock.invocationCallOrder[0]).toBeLessThan(
    animate.mock.invocationCallOrder[1]!,
  );
  act(() => {
    reducedMotion = true;
    preferenceEvents.dispatchEvent(new Event("change"));
  });
  expect(animations[1]?.cancel).toHaveBeenCalledTimes(1);
  rerender(<RouteContent pathname="/third" />);
  expect(animate).toHaveBeenCalledTimes(2);
  act(() => {
    reducedMotion = false;
    preferenceEvents.dispatchEvent(new Event("change"));
  });
  expect(animate).toHaveBeenCalledTimes(2);
  rerender(<RouteContent pathname="/fourth" />);
  expect(animate).toHaveBeenCalledTimes(3);
  unmount();
  expect(animations[2]?.cancel).toHaveBeenCalledTimes(1);
});

it("keeps content visible when reduced motion, zero duration, or animation support disables entry", () => {
  reducedMotion = true;
  const { rerender } = render(<RouteContent pathname="/first" />);
  expect(animate).not.toHaveBeenCalled();
  reducedMotion = false;
  motionStyle.setProperty("--arc-motion-enter", "0ms");
  rerender(<RouteContent pathname="/second" />);
  expect(animate).not.toHaveBeenCalled();
  Object.defineProperty(HTMLElement.prototype, "animate", { value: undefined });
  rerender(<RouteContent pathname="/third" />);
  expect(screen.getByTestId("content").style.opacity).toBe("");
  expect(screen.getByRole("textbox", { name: "Editor" }).isConnected).toBe(
    true,
  );
});
