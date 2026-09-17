export const liquidGlassCss = `
:where(.bb-app-shell-root) {
  --arc-surface-style: liquid-glass;
  --arc-glass-panel: color-mix(in oklab, var(--sidebar) 82%, transparent);
  --arc-glass-card: color-mix(in oklab, var(--card) 76%, transparent);
  --arc-glass-popup: color-mix(in oklab, var(--popover) 92%, transparent);
  --arc-glass-edge: color-mix(in oklab, var(--ink) 15%, transparent);
  --arc-glass-shine: color-mix(in oklab, var(--ink) 7%, transparent);
  --arc-glass-shadow: color-mix(in oklab, var(--canvas) 45%, transparent);
  --arc-glass-blur: blur(24px) saturate(1.2);
  --arc-glass-backdrop:
    radial-gradient(ellipse at 0% 0%, color-mix(in oklch, var(--primary) 18%, var(--canvas)), transparent 65%),
    radial-gradient(ellipse at 100% 100%, color-mix(in oklch, var(--timeline-accent) 24%, var(--canvas)), transparent 70%),
    var(--canvas);
}

:where(.bb-app-shell-root:not(.dark)) {
  --arc-glass-panel: color-mix(in oklab, var(--sidebar) 88%, transparent);
  --arc-glass-card: color-mix(in oklab, var(--card) 86%, transparent);
  --arc-glass-shine: color-mix(in oklab, var(--canvas) 65%, transparent);
  --arc-glass-shadow: color-mix(in oklab, var(--ink) 6%, transparent);
}

:where(.bb-app-shell-root) :where(body) {
  background: var(--arc-glass-backdrop);
  background-attachment: fixed;
}

:where(.bb-app-shell-root) :where(
  #root,
  [data-testid="app-layout-root"],
  [data-sidebar="inset"],
  [data-sidebar="sidebar"],
  [data-sidebar="content"],
  .arc-thread-browser,
  [data-arc-glass-body],
  [data-arc-agent-studio],
  [data-arc-team-builder]
) {
  background-color: transparent;
}

:where(.bb-app-shell-root) :where([data-sidebar="inset"][data-sidebar-shelf]) {
  background: var(--arc-glass-backdrop);
}

:where(.bb-app-shell-root) :where(
  [data-sidebar="panel"],
  .arc-window-titlebar,
  .arc-thread-browser-surface,
  [data-arc-glass-panel]
) {
  background-color: var(--arc-glass-panel);
  background-image: linear-gradient(150deg, var(--arc-glass-shine), transparent 42%);
  border-color: var(--arc-glass-edge);
  box-shadow: inset 0 1px 0 var(--arc-glass-shine);
  -webkit-backdrop-filter: var(--arc-glass-blur);
  backdrop-filter: var(--arc-glass-blur);
}

:where(.bb-app-shell-root) :where([data-promptbox], [data-arc-glass-card]) {
  background-color: var(--arc-glass-card);
  background-image: linear-gradient(150deg, var(--arc-glass-shine), transparent 45%);
  border-color: var(--arc-glass-edge);
  box-shadow: inset 0 1px 0 var(--arc-glass-shine), 0 8px 28px -12px var(--arc-glass-shadow);
  -webkit-backdrop-filter: var(--arc-glass-blur);
  backdrop-filter: var(--arc-glass-blur);
}

:where(.bb-app-shell-root) :where(
  .arc-overlay-motion:is(.bg-popover, .bg-background),
  [data-persistent-drawer-content]
) {
  background-color: var(--arc-glass-popup);
  border-color: var(--arc-glass-edge);
  -webkit-backdrop-filter: var(--arc-glass-blur);
  backdrop-filter: var(--arc-glass-blur);
}

:where(.bb-app-shell-root.dark[data-native-glass="acrylic"], .bb-app-shell-root.dark[data-native-glass="vibrancy"]),
:where(.bb-app-shell-root.dark[data-native-glass="acrylic"], .bb-app-shell-root.dark[data-native-glass="vibrancy"]) :where(body) {
  background: transparent;
}

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  :where(.bb-app-shell-root) {
    --arc-glass-panel: var(--sidebar);
    --arc-glass-card: var(--card);
    --arc-glass-popup: var(--popover);
  }
}

@media (prefers-reduced-transparency: reduce), (forced-colors: active) {
  :where(.bb-app-shell-root) {
    --arc-glass-panel: var(--sidebar);
    --arc-glass-card: var(--card);
    --arc-glass-popup: var(--popover);
    --arc-glass-shine: transparent;
    --arc-glass-shadow: transparent;
    --arc-glass-blur: none;
    --arc-glass-backdrop: var(--canvas);
  }

  :where(.bb-app-shell-root), :where(.bb-app-shell-root) :where(body) {
    background: var(--canvas);
  }
}
`;
