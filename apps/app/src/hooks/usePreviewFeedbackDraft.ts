import { useEffect, useRef } from "react";
import type { BbDesktopBrowserFeedback } from "@bb/desktop-contract";
import type { PromptDraftAttachment } from "@bb/client-core";
import { useUploadPromptAttachment } from "@/hooks/mutations/project-mutations";
import { decodeBase64Bytes } from "@/lib/base64-bytes";

type FeedbackHandler = (feedback: BbDesktopBrowserFeedback) => Promise<void>;
const handlers = new Map<string, Map<symbol, FeedbackHandler>>();

export async function addPreviewFeedbackToDraft(
  threadId: string,
  feedback: BbDesktopBrowserFeedback,
): Promise<void> {
  const handler = [...(handlers.get(threadId)?.values() ?? [])].at(-1);
  if (!handler)
    throw new Error(
      "Open this preview's conversation composer before adding feedback",
    );
  await handler(feedback);
}

export function previewFeedbackText(
  feedback: BbDesktopBrowserFeedback,
): string {
  const lines = [
    `Preview feedback: ${feedback.title || feedback.url}`,
    `URL: ${feedback.url}`,
  ];
  if (feedback.element)
    lines.push(
      `Selected element: ${feedback.element.selector}`,
      `Text: ${feedback.element.text}`,
      `Bounds: ${JSON.stringify(feedback.element.rect)}`,
    );
  if (feedback.console.length)
    lines.push(
      "Recent console messages:",
      ...feedback.console
        .slice(-20)
        .map((row) => `${row.level}: ${row.message}`),
    );
  if (feedback.network.length)
    lines.push(
      "Recent network requests (no headers, query strings or bodies):",
      ...feedback.network
        .slice(-20)
        .map(
          (row) =>
            `${row.method} ${row.status} ${row.url}${row.error ? ` — ${row.error}` : ""}`,
        ),
    );
  return lines.join("\n").slice(0, 16_000);
}

export function usePreviewFeedbackDraft({
  threadId,
  projectId,
  append,
}: {
  threadId: string | null | undefined;
  projectId: string;
  append: (
    text: string,
    attachments?: readonly PromptDraftAttachment[],
  ) => void;
}) {
  const upload = useUploadPromptAttachment();
  const current = useRef({
    threadId,
    projectId,
    append,
    upload: upload.mutateAsync,
  });
  current.current = { threadId, projectId, append, upload: upload.mutateAsync };
  useEffect(() => {
    if (!threadId) return;
    const token = Symbol();
    let active = true;
    const callback: FeedbackHandler = async (feedback) => {
      const bytes = decodeBase64Bytes(feedback.screenshot);
      const file = new File([new Uint8Array(bytes)], "arc-preview.jpg", {
        type: "image/jpeg",
      });
      const attachment = await current.current.upload({ projectId, file });
      if (
        !active ||
        current.current.threadId !== threadId ||
        current.current.projectId !== projectId
      )
        throw new Error(
          "The conversation changed while capturing. Return to the preview and add it again.",
        );
      current.current.append(previewFeedbackText(feedback), [attachment]);
    };
    const entries = handlers.get(threadId) ?? new Map();
    entries.set(token, callback);
    handlers.set(threadId, entries);
    return () => {
      active = false;
      entries.delete(token);
      if (!entries.size) handlers.delete(threadId);
    };
  }, [threadId, projectId]);
}
