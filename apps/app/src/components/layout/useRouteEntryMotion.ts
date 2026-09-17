import { type RefObject, useLayoutEffect } from "react";

export function useRouteEntryMotion(
  target: RefObject<HTMLElement | null>,
  pathname: string,
) {
  useLayoutEffect(() => {
    const element = target.current;
    if (!element || typeof element.animate !== "function") return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (preference.matches) return;
    const style = window.getComputedStyle(element);
    const token = style.getPropertyValue("--arc-motion-enter").trim();
    const time = /^(\d+(?:\.\d+)?)(ms|s)$/u.exec(token);
    const duration = time
      ? Number(time[1]) * (time[2] === "s" ? 1000 : 1)
      : 160;
    if (duration === 0) return;
    const animation = element.animate([{ opacity: 0.94 }, { opacity: 1 }], {
      duration,
      easing:
        style.getPropertyValue("--arc-motion-ease").trim() ||
        "cubic-bezier(0.2, 0, 0, 1)",
    });
    const stopForReducedMotion = () => {
      if (preference.matches) animation.cancel();
    };
    preference.addEventListener("change", stopForReducedMotion);
    return () => {
      preference.removeEventListener("change", stopForReducedMotion);
      animation.cancel();
    };
  }, [pathname, target]);
}
