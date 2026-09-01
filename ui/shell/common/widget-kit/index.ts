// ─────────────────────────────────────────────────────────────────────────────
// The widget kit — the vocabulary a widget is written against.
//
// A widget file imports THIS and nothing from surfaces/: it declares what it is
// (contract.ts), the shape its content takes (tile.ts) and the room it draws in
// (panel.ts), and the bar and the Control Centre decide where that lands. Adding a
// word to the widget vocabulary means adding it here, so there is one page to read
// and one place to look.
//
// Leaf modules only — see panel.ts for the import cycle that crashes the shell.
// ─────────────────────────────────────────────────────────────────────────────
export * from "./contract"
export * from "./panel"
export * from "./tile"
