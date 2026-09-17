import type { ReactNode } from "react";
import type { BrowserHtmlPreviewSource } from "@bb/server-contract";
import { isHtmlFilePreviewPath } from "@bb/client-core";
import { Button } from "@bb/shared-ui/button";
import { isDesktopBrowserAvailable } from "@/lib/bb-desktop";
export function HtmlPreviewOpenAction({
  source,
  onOpen,
  children,
}: {
  source: BrowserHtmlPreviewSource | null;
  onOpen?: (source: BrowserHtmlPreviewSource) => void;
  children: ReactNode;
}) {
  return (
    <>
      {source &&
        onOpen &&
        isHtmlFilePreviewPath(source.filePath) &&
        isDesktopBrowserAvailable() && (
          <div className="shrink-0 border-b px-3 py-1">
            <Button size="sm" variant="ghost" onClick={() => onOpen(source)}>
              Inspect in Preview
            </Button>
            <span className="ml-2 text-xs text-muted-foreground">
              Select elements and add screenshots to your draft
            </span>
          </div>
        )}
      {children}
    </>
  );
}
