import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { BrowserHtmlPreviewSource } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { getDesktopBrowserApi } from "@/lib/bb-desktop";
import { BrowserTabContent } from "./BrowserTabContent";

type HtmlPreviewLease = {
  url: string;
  baseUrl: string;
  expiresAtMs: number;
  sourceKey: string;
};

export function NativeHtmlPreview({
  source,
  ...props
}: ComponentProps<typeof BrowserTabContent> & {
  source: BrowserHtmlPreviewSource;
}) {
  const [lease, setLease] = useState<HtmlPreviewLease | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const observedLease = useRef<string | null>(null);
  const { canShowNativeBrowserView: visible, tabId } = props;
  const sourceKey = JSON.stringify([
    source.hostId,
    source.rootPath,
    source.filePath,
  ]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HtmlPreviewLease | null = null;
    const controller = new AbortController();
    setLease(null);
    observedLease.current = null;
    const create = async () => {
      const value = await sdk.files.createPreview({
        hostId: source.hostId,
        rootPath: source.rootPath,
        signal: controller.signal,
      });
      current = {
        ...value,
        sourceKey,
        url: new URL(
          `${value.baseUrl}/${source.filePath.replace(/\\/gu, "/").split("/").map(encodeURIComponent).join("/")}`,
          window.location.origin,
        ).href,
      };
      if (!stopped) {
        setLease(current);
        setError(null);
      }
    };
    const poll = async () => {
      if (stopped) return;
      try {
        if (!current || current.expiresAtMs <= Date.now()) await create();
        else {
          const id = current.baseUrl.split("/").at(-1)!;
          const result = await sdk.files.experimental_refreshPreview({
            previewId: id,
            signal: controller.signal,
          });
          if (stopped) return;
          current = { ...current, expiresAtMs: result.expiresAtMs };
          setLease(current);
          setError(
            result.truncated
              ? "Live reload reached its 2,048-file limit; refresh manually for additional assets."
              : null,
          );
          if (result.changed) getDesktopBrowserApi()?.reload(tabId);
        }
      } catch (failure) {
        if (stopped) return;
        current = null;
        setLease(null);
        setError(
          failure instanceof Error
            ? failure.message
            : "HTML preview is unavailable",
        );
      }
      if (!stopped) timer = setTimeout(() => void poll(), 3000);
    };
    if (visible) void poll();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [
    source.hostId,
    source.rootPath,
    source.filePath,
    sourceKey,
    tabId,
    visible,
    retry,
  ]);
  if (
    !lease ||
    lease.sourceKey !== sourceKey ||
    lease.expiresAtMs <= Date.now()
  )
    return (
      <div
        className="p-4 text-sm text-muted-foreground"
        role={error ? "alert" : "status"}
      >
        {error ?? "Preparing a scoped HTML preview…"}
        {error && (
          <button
            className="ml-2 underline"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry
          </button>
        )}
      </div>
    );
  return (
    <>
      {error && (
        <p
          role="status"
          className="border-b px-3 py-1 text-xs text-muted-foreground"
        >
          {error}
        </p>
      )}
      <BrowserTabContent
        {...props}
        key={lease.url}
        initialUrl={lease.url}
        navigateOnAttach
        onUpdate={(value) => {
          const withinLease = value.url.startsWith(
            new URL(lease.baseUrl, window.location.origin).href + "/",
          );
          if (withinLease) observedLease.current = lease.url;
          const leftLease =
            observedLease.current === lease.url &&
            !withinLease &&
            value.url.length > 0 &&
            value.url !== "about:blank";
          props.onUpdate({ ...value, htmlSource: leftLease ? null : source });
        }}
      />
    </>
  );
}

export function HtmlBrowserContent({
  source,
  ...props
}: ComponentProps<typeof BrowserTabContent> & {
  source?: BrowserHtmlPreviewSource;
}) {
  return source ? (
    <NativeHtmlPreview {...props} source={source} />
  ) : (
    <BrowserTabContent {...props} />
  );
}
