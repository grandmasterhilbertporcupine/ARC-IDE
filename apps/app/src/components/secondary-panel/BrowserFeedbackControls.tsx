import { useState } from "react";
import type { BbDesktopBrowserApi } from "@bb/desktop-contract";
import { Button } from "@bb/shared-ui/button";
import { addPreviewFeedbackToDraft } from "@/hooks/usePreviewFeedbackDraft";

export function BrowserFeedbackControls({
  browser,
  threadId,
  tabId,
  disabled,
}: {
  browser: BbDesktopBrowserApi;
  threadId: string;
  tabId: string;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState<"capture" | "select" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!browser.captureFeedback) return null;
  const capture = async (mode: "capture" | "select") => {
    setBusy(mode);
    setMessage(null);
    try {
      if (mode === "select") browser.focus?.(tabId);
      const feedback = await browser.captureFeedback?.({
        threadId,
        tabId,
        mode,
      });
      if (feedback) {
        await addPreviewFeedbackToDraft(threadId, feedback);
        setMessage("Screenshot and feedback added to your draft.");
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Could not capture preview",
      );
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="shrink-0 border-b border-border px-3 py-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || busy !== null}
          onClick={() => void capture("select")}
        >
          Select element
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled || busy !== null}
          onClick={() => void capture("capture")}
        >
          Add screenshot to chat
        </Button>
        {busy === "select" && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void browser
                .captureFeedback?.({
                  threadId,
                  tabId,
                  mode: "cancel",
                })
                .catch(() =>
                  setMessage(
                    "Selection ended because the preview is unavailable.",
                  ),
                )
            }
          >
            Cancel selection
          </Button>
        )}
      </div>
      {busy === "select" && (
        <p role="status" className="py-1 text-muted-foreground">
          Click an element in the page. Escape cancels. Selection ends after 20
          seconds.
        </p>
      )}
      {message && (
        <p role="status" className="py-1 text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
}
