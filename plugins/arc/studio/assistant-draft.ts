import { useEffect } from "react";
import { z } from "zod";

export const assistantDraftEvent = "arc:authoring-draft";
export function queueAssistantDraft(key: string, prompt: string) {
  let text = prompt;
  try {
    const previous = localStorage.getItem(key)?.trim();
    if (previous) text = `${previous}\n\n${prompt}`;
    localStorage.setItem(key, text);
    localStorage.setItem(`${key}.queued`, "true");
  } catch {}
  window.dispatchEvent(
    new CustomEvent(assistantDraftEvent, { detail: { key, prompt: text } }),
  );
}

export function useAssistantDraft(
  key: string,
  setPrompt: (prompt: string) => void,
  setCompose: (compose: boolean) => void,
) {
  useEffect(() => {
    const receive = (prompt: string) => {
      setPrompt(prompt);
      setCompose(true);
      try {
        localStorage.removeItem(`${key}.queued`);
      } catch {}
    };
    try {
      if (localStorage.getItem(`${key}.queued`) === "true")
        receive(localStorage.getItem(key) ?? "");
    } catch {}
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const parsed = z
        .object({ key: z.string(), prompt: z.string() })
        .safeParse(event.detail);
      if (parsed.success && parsed.data.key === key)
        receive(parsed.data.prompt);
    };
    window.addEventListener(assistantDraftEvent, listener);
    return () => window.removeEventListener(assistantDraftEvent, listener);
  }, [key, setPrompt, setCompose]);
}
