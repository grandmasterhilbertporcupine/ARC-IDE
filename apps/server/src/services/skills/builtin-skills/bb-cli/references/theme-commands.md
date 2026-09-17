# Theme commands

## Theming

- `bb theme` controls the **app-wide color palette and surface style** — CSS
  overrides persisted server-side and applied live to every open window.
  Light/dark _mode_ is a separate per-client setting. Surface style is
  `default` or `liquid-glass`, independently of the selected palette.
- **Custom themes live on disk** under the app data dir, one folder per theme:
  `<bb-data-dir>/theme/<name>/theme.css` (the packaged app uses `~/.bb/theme/…`).
  The folder name _is_ the theme id. This mirrors how user skills live under
  `<bb-data-dir>/skills/<name>/`.
- All theme commands support `--json`.
- Commands:
  - `bb theme list` — built-in and custom themes and which palette is active.
  - `bb theme dir` — print the absolute custom-theme directory (where to create
    `<name>/theme.css`). Use this instead of guessing the path.
  - `bb theme set <id> [--favicon-color <color>]` — activate a built-in
    (`default`, `nord`, `dracula`, `solarized`, `gruvbox`, `catppuccin`), custom,
    or plugin-contributed theme. Without the flag it preserves the favicon
    color; with the flag it updates that color too. Both preserve surface style.
  - `bb theme show [--css]` — print the active palette. For a custom theme,
    `--css` prints its CSS. For a built-in theme, it reports that ARC bundles
    the CSS.
  - `bb theme reset` — back to `default` while preserving the favicon color.
  - `bb theme favicon set <color>` — set the favicon color while preserving the
    active theme. Colors: `default`, `red`, `orange`, `yellow`, `green`, `teal`,
    `blue`, `purple`, `pink`.
  - `bb theme favicon reset` — reset the favicon color to `default` while
    preserving the active theme.
  - `bb theme style set <style>` — choose `default` or `liquid-glass` while
    preserving the palette and favicon color. Liquid Glass defaults off.
  - `bb theme style reset` — restore default surfaces while preserving the
    palette and favicon color.

Palette and favicon commands preserve surface style, including `bb theme reset`.
`bb theme show` and `bb theme list` include the active surface style. The SDK
uses `sdk.theme.set({ themeId, faviconColor, surfaceStyle })` and `sdk.theme.get()`.

### Creating or editing a custom theme

This is the ARC habit: custom app-theme work belongs in
`<bb-data-dir>/theme/<name>/theme.css` — never a stray `.css` file elsewhere.

1. Find the directory: `bb theme dir` (e.g. `~/.bb/theme`).
2. Write the stylesheet to `<that-dir>/<name>/theme.css` (create the folder). Use
   a name of at most 64 characters. Start with a letter or digit. After that,
   use letters, digits, dots, underscores, or hyphens. Avoid a built-in ID.
3. Activate it: `bb theme set <name>`. Changes apply live to every open window.

Code colors follow the active palette. Built-in palettes use the matching
Shiki pair (Nord, Dracula, Solarized, Gruvbox, Catppuccin). To restyle diffs
for a custom palette, put Pierre / VS Code theme JSON next to the stylesheet:

- `pierre-dark.json` and `pierre-light.json` in the same folder, or
- `theme.json` with `{ "codeTheme": { "dark": "…", "light": "…" } }` — each
  side is a bundled Shiki name (`github-dark`) or a folder-relative `.json`
  file.

See [Pierre theme authoring](https://diffs.com/theme) for the JSON shape.

To author the stylesheet, **read `references/theming.md` (in this skill's
directory) first.** It is the full design-token reference — what every CSS
variable drives, which tokens to set vs. which auto-derive — plus the two-block
light/dark structure, how to set colors and fonts, and a worked example.

The short version: a custom theme is a plain CSS file that overrides CSS custom
properties. Set the two anchors `--canvas`/`--ink` (most of the UI derives from
them by mixing ink into canvas), the `--primary` accent, the secondary text tiers
(`--muted-foreground` etc.), and the semantic colors (`--destructive`,
`--success`, …). Ship one file with a `:root, .light` block and a `.dark` block.
