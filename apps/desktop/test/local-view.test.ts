import { describe, expect, it } from "vitest";
import { createLocalViewUrl, type LocalViewModel } from "../src/local-view.js";

interface DecodeLocalViewHtmlArgs {
  viewModel: LocalViewModel;
}

interface LocalViewTestCase {
  label: string;
  viewModel: LocalViewModel;
}

const LOCAL_VIEW_URL_PREFIX = "data:text/html;charset=utf-8,";

const localViewTestCases: LocalViewTestCase[] = [
  {
    label: "loading",
    viewModel: {
      kind: "loading",
      message: "Starting local services.",
      title: "Opening bb",
    },
  },
  {
    label: "error",
    viewModel: {
      details: "The local service failed to start.",
      kind: "error",
      logText: "Failed to bind port",
      title: "Could not open bb",
    },
  },
  {
    label: "info",
    viewModel: {
      kind: "info",
      message:
        "A bb server is already running on this Mac. Connect via Window ▸ Server.",
      title: "Local server available",
    },
  },
];

function decodeLocalViewHtml(args: DecodeLocalViewHtmlArgs): string {
  const url = createLocalViewUrl({ viewModel: args.viewModel, titleBar: null });

  expect(url.startsWith(LOCAL_VIEW_URL_PREFIX)).toBe(true);

  return decodeURIComponent(url.slice(LOCAL_VIEW_URL_PREFIX.length));
}

describe("local desktop views", () => {
  it.each(localViewTestCases)(
    "renders an invisible window drag region for the $label view",
    (testCase) => {
      const html = decodeLocalViewHtml({ viewModel: testCase.viewModel });

      expect(html).toContain(
        '<div class="titlebar-drag-region" data-testid="bb-local-view-window-drag-region" aria-hidden="true"></div>',
      );
      expect(html).toMatch(
        /\.titlebar-drag-region\s+\{[\s\S]*app-region: drag;[\s\S]*-webkit-app-region: drag;[\s\S]*background: transparent;[\s\S]*border: 0;[\s\S]*height: 28px;/u,
      );
      expect(html).toMatch(
        /button,\s+a,\s+input,\s+textarea,\s+select,\s+summary,\s+pre\s+\{[\s\S]*app-region: no-drag;[\s\S]*-webkit-app-region: no-drag;/u,
      );
    },
  );

  it("renders startup error logs without terminal control sequences", () => {
    const html = decodeLocalViewHtml({
      viewModel: {
        details: "The local service failed to start.",
        kind: "error",
        logText:
          "\x1b[2K  \x1b[2m○\x1b[0m  Starting server\r\x1b[2K  \x1b[32m✓\x1b[0m  Server listening\nError: listen EADDRINUSE",
        title: "Could not open bb",
      },
    });

    expect(html).toContain("<pre>");
    expect(html).toContain("Starting server");
    expect(html).toContain("Server listening");
    expect(html).toContain("Error: listen EADDRINUSE");
    expect(html).not.toContain("\x1b[");
    expect(html).not.toContain("\r");
  });

  it.each(localViewTestCases)(
    "keeps ARC branding, zoom-aware caption space and selectable logs available in Windows $label views",
    ({ viewModel }) => {
      const html = decodeURIComponent(
        createLocalViewUrl({
          viewModel,
          titleBar: { logoDataUrl: "data:image/png;base64,AA==" },
        }).slice(LOCAL_VIEW_URL_PREFIX.length),
      );
      expect(html).toContain(
        '<img src="data:image/png;base64,AA==" alt=""><span>ARC</span>',
      );
      expect(html).toMatch(
        /\.titlebar-drag-region\s*\{[^}]*height: calc\(env\(titlebar-area-y, 0px\) \+ env\(titlebar-area-height, 36px\)\);/u,
      );
      expect(html).toMatch(
        /body\s*\{[^}]*box-sizing: border-box;[^}]*padding-top: calc\(env\(titlebar-area-y, 0px\) \+ env\(titlebar-area-height, 36px\)\);/u,
      );
      expect(html).toContain(
        "width: env(titlebar-area-width, calc(100% - 138px))",
      );
      expect(html).toMatch(/\.titlebar-brand\s*\{[^}]*padding-left: 16px;/u);
      expect(html).toContain(
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      );
      expect(html).toMatch(/pre\s*\{[^}]*app-region: no-drag;/u);
      expect(html).not.toContain("<script");
    },
  );

  it.each(localViewTestCases)(
    "removes Windows title bar geometry from fullscreen $label views",
    ({ viewModel }) => {
      const html = decodeURIComponent(
        createLocalViewUrl({
          viewModel,
          titleBar: { logoDataUrl: "data:image/png;base64,AA==" },
        }).slice(LOCAL_VIEW_URL_PREFIX.length),
      );
      expect(html).toContain("<html data-bb-local-view>");
      expect(html).toMatch(
        /html\[data-bb-desktop-fullscreen="true"\] \.titlebar-drag-region\s*\{\s*display: none;\s*\}/u,
      );
      expect(html).toMatch(
        /html\[data-bb-desktop-fullscreen="true"\] body\s*\{\s*padding-top: 0;\s*\}/u,
      );
      expect(html).toMatch(
        /@media \(display-mode: fullscreen\)\s*\{\s*\.titlebar-drag-region\s*\{\s*display: none;\s*\}\s*body\s*\{\s*padding-top: 0;\s*\}/u,
      );
      const nativeFrameHtml = decodeLocalViewHtml({ viewModel });
      expect(nativeFrameHtml).not.toContain(
        "@media (display-mode: fullscreen)",
      );
      expect(nativeFrameHtml).not.toContain("data-bb-desktop-fullscreen");
      expect(nativeFrameHtml).toMatch(
        /\.titlebar-drag-region\s*\{[^}]*height: 28px;/u,
      );
      expect(nativeFrameHtml).toMatch(/body\s*\{[^}]*padding-top: 0px;/u);
    },
  );

  it("escapes local-view text and logo attributes without adding executable markup", () => {
    const html = decodeURIComponent(
      createLocalViewUrl({
        titleBar: {
          logoDataUrl: 'data:image/png;base64,AA==" onerror="alert(1)',
        },
        viewModel: {
          kind: "error",
          title: "<script>bad()</script>",
          details: '<img src=x onerror="bad()">',
          logText: "</pre><script>bad()</script>",
        },
      }).slice(LOCAL_VIEW_URL_PREFIX.length),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain(' onerror="');
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
  });
});
