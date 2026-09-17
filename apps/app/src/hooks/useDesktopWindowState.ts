import { useEffect, useState } from "react";
import type { BbDesktopWindowState } from "@bb/desktop-contract";
import {
  DEFAULT_DESKTOP_WINDOW_STATE,
  getBbDesktopInfo,
} from "@/lib/bb-desktop";

export function useDesktopWindowState(): BbDesktopWindowState {
  const [windowState, setWindowState] = useState<BbDesktopWindowState>(
    DEFAULT_DESKTOP_WINDOW_STATE,
  );

  useEffect(() => {
    const desktopApi = getBbDesktopInfo();
    let cancelled = false;
    let receivedWindowState = false;

    const unsubscribe = desktopApi?.onWindowStateChange?.((nextState) => {
      receivedWindowState = true;
      if (!cancelled) setWindowState(nextState);
    });

    void desktopApi?.getWindowState?.().then((nextState) => {
      if (!cancelled && !receivedWindowState) {
        setWindowState(nextState);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return windowState;
}
