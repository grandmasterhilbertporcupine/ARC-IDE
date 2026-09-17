import type { WebContents } from "electron";
import {
  bbDesktopBrowserElementSchema,
  type BbDesktopBrowserElement,
} from "@bb/desktop-contract";

export function redactPreviewDiagnostic(value: string): string {
  return value
    .replace(/\b(Bearer\s+)\S+/giu, "$1[redacted]")
    .replace(
      /\b(authorization|password|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$1=[redacted]",
    )
    .slice(0, 1000);
}

export function previewDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.slice(0, 2048);
  } catch {
    return "[unavailable URL]";
  }
}

const SELECTION_WORLD = 1007;
const CANCEL_SELECTION = "globalThis.__arcCancelPreviewSelection?.(); null";
const SELECT_ELEMENT = `new Promise((resolve) => {
  globalThis.__arcCancelPreviewSelection?.();
  let current = null;
  const highlight = document.createElement('div');
  Object.assign(highlight.style, { position: 'fixed', pointerEvents: 'none', zIndex: '2147483647', border: '2px solid #537cfa', background: '#537cfa22', borderRadius: '3px' });
  document.documentElement.append(highlight);
  function cleanup(value) {
    clearTimeout(timer);
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('click', click, true);
    document.removeEventListener('keydown', key, true);
    highlight.remove();
    delete globalThis.__arcCancelPreviewSelection;
    resolve(value);
  }
  function move(event) {
    current = event.target instanceof Element ? event.target : null;
    if (!current) return;
    const box = current.getBoundingClientRect();
    Object.assign(highlight.style, { left: box.x + 'px', top: box.y + 'px', width: box.width + 'px', height: box.height + 'px' });
  }
  function click(event) {
    event.preventDefault(); event.stopImmediatePropagation();
    const element = event.target instanceof Element ? event.target : current;
    if (!element) return cleanup(null);
    const box = element.getBoundingClientRect();
    const parts = [];
    let node = element;
    while (node && parts.length < 8) {
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let selector = node.tagName.toLowerCase();
      if (node.parentElement) { const siblings = Array.from(node.parentElement.children).filter((child) => child.tagName === node.tagName); if (siblings.length > 1) selector += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')'; }
      parts.unshift(selector); node = node.parentElement;
    }
    cleanup({ tag: element.tagName.toLowerCase(), selector: parts.join(' > ').slice(0, 2048), text: (element.textContent || '').trim().slice(0, 1500), role: (element.getAttribute('role') || '').slice(0, 100), rect: { x: box.x, y: box.y, width: box.width, height: box.height } });
  }
  function key(event) { if (event.key === 'Escape') { event.preventDefault(); cleanup(null); } }
  const timer = setTimeout(() => cleanup(null), 20000);
  globalThis.__arcCancelPreviewSelection = () => cleanup(null);
  document.addEventListener('mousemove', move, true);
  document.addEventListener('click', click, true);
  document.addEventListener('keydown', key, true);
})`;

export async function selectPreviewElement(
  contents: WebContents,
): Promise<BbDesktopBrowserElement | null> {
  const result: unknown = await contents.executeJavaScriptInIsolatedWorld(
    SELECTION_WORLD,
    [{ code: SELECT_ELEMENT }],
  );
  return bbDesktopBrowserElementSchema.nullable().parse(result);
}

export async function cancelPreviewElementSelection(
  contents: WebContents,
): Promise<void> {
  await contents.executeJavaScriptInIsolatedWorld(SELECTION_WORLD, [
    { code: CANCEL_SELECTION },
  ]);
}
