import { useEffect } from "react";
import { useMediaQuery } from "@bb/shared-ui/hooks/use-media-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { getBbDesktopInfo } from "@/lib/bb-desktop";
import { usePreferredTheme, useThemePreference } from "./useTheme";

export function useDesktopThemeSync(): void {
  const themePreference = useThemePreference();
  const theme = usePreferredTheme();
  const { data } = useSystemConfig();
  const reducedTransparency = useMediaQuery(
    "(prefers-reduced-transparency: reduce)",
  );
  const forcedColors = useMediaQuery("(forced-colors: active)");
  const surfaceStyle =
    data?.appearance.surfaceStyle === "liquid-glass" &&
    theme === "dark" &&
    !reducedTransparency &&
    !forcedColors
      ? "liquid-glass"
      : "default";
  useEffect(() => {
    const desktopApi = getBbDesktopInfo();
    desktopApi?.setTheme(themePreference);
  }, [themePreference]);

  useEffect(() => {
    const root = document.documentElement;
    delete root.dataset.nativeGlass;
    const desktopApi = getBbDesktopInfo();
    if (!desktopApi?.setSurfaceStyle) return;
    let active = true;
    void desktopApi.setSurfaceStyle(surfaceStyle).then(
      ({ material }) => {
        if (active && surfaceStyle === "liquid-glass" && material !== "none") {
          root.dataset.nativeGlass = material;
        }
      },
      () => {},
    );
    return () => {
      active = false;
      delete root.dataset.nativeGlass;
      void desktopApi.setSurfaceStyle?.("default").catch(() => {});
    };
  }, [surfaceStyle]);
}
