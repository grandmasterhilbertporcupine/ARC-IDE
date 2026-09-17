import { useCallback, useEffect, useState, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { THREAD_JUMP_APP_COMMAND_IDS } from "@bb/domain";
import {
  useAppCommandHandler,
  useAppCommandShortcuts,
  useIndexedAppCommandHandlers,
  useIsAppCommandModifierHeld,
} from "@/components/commands/AppCommandProvider";
import { getThreadRoutePath } from "@/lib/route-paths";
import {
  EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS,
  getSidebarThreadNavigationTargets,
  getSidebarThreadShortcutTargets,
  type SidebarThreadShortcutPresentation,
  type SidebarThreadShortcutTarget,
} from "./sidebarThreadShortcuts";

export function useThreadBrowserNavigation(
  ref: RefObject<HTMLDivElement | null>,
  activeThreadId: string | undefined,
  enabled: boolean,
  version: string,
  onNavigate: () => void,
) {
  const navigate = useNavigate();
  const shortcuts = useAppCommandShortcuts(THREAD_JUMP_APP_COMMAND_IDS);
  const held = useIsAppCommandModifierHeld();
  const [keys, setKeys] = useState<
    ReadonlyMap<string, SidebarThreadShortcutPresentation>
  >(EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS);
  const open = useCallback(
    (target: SidebarThreadShortcutTarget | undefined) => {
      if (!enabled || !target) return false;
      if (target.element) target.element.click();
      else if (target.projectId)
        void navigate(
          getThreadRoutePath({
            projectId: target.projectId,
            threadId: target.threadId,
          }),
        );
      else return false;
      onNavigate();
      return true;
    },
    [enabled, navigate, onNavigate],
  );
  const indexed = useCallback(
    (index: number) =>
      open(getSidebarThreadShortcutTargets(ref.current)[index]),
    [open, ref],
  );
  useIndexedAppCommandHandlers(THREAD_JUMP_APP_COMMAND_IDS, indexed);
  const adjacent = (offset: number) => {
    const targets = getSidebarThreadNavigationTargets(ref.current);
    const current = targets.findIndex(
      (target) => target.threadId === activeThreadId,
    );
    if (targets.length === 0) return false;
    const next =
      current < 0
        ? offset < 0
          ? targets.length - 1
          : 0
        : (current + offset + targets.length) % targets.length;
    return open(targets[next]);
  };
  useAppCommandHandler("thread.previous", () => adjacent(-1));
  useAppCommandHandler("thread.next", () => adjacent(1));
  useEffect(() => {
    if (!held || !enabled) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      const targets = getSidebarThreadShortcutTargets(ref.current);
      setKeys(
        new Map(
          targets.flatMap((target, index) => {
            const command = THREAD_JUMP_APP_COMMAND_IDS[index];
            const shortcut = command ? shortcuts.get(command) : undefined;
            return shortcut ? [[target.threadId, shortcut] as const] : [];
          }),
        ),
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled, held, ref, shortcuts, version]);
  return held && enabled ? keys : EMPTY_SIDEBAR_THREAD_SHORTCUT_KEYS;
}
