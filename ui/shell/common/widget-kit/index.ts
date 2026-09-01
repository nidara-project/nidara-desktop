// ─────────────────────────────────────────────────────────────────────────────
// The widget kit — the vocabulary a widget is written against.
//
// A widget file imports THIS and nothing from surfaces/: it declares what it is
// (contract.ts), the shape its content takes in the Control Centre (tile.ts) and in
// the bar (bar.ts), and the room a panel opens for it (panel.ts) — and the two hosts
// decide where that lands. Adding a word to the widget vocabulary means adding it
// here, so there is one page to read and one place to look:
// .claude/skills/nidara/references/writing-a-widget.md
//
// Leaf modules only — see panel.ts for the import cycle that crashes the shell.
// ─────────────────────────────────────────────────────────────────────────────
export * from "./contract"
export * from "./panel"
export * from "./tile"
export * from "./bar"
