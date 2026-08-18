// Ambient declarations for what scripts/bundle.sh injects or loads.
//
// SRC is defined by the bundler as the entry file's directory (AGS parity —
// nothing in the shell reads it today; core/Paths.ts uses NIDARA_SHELL_ROOT).
declare const SRC: string

// `--loader:.css=text`: importing a stylesheet yields its text. Note the shell
// does NOT do this — style.css is read at RUNTIME from SHELL_ROOT so a theme
// change can reload it without a rebuild.
declare module "*.css" {
  const content: string
  export default content
}

// (The `inline:*`, `*.scss` and `*.blp` module declarations were AGS bundler
// plugins we never used. They left with `ags bundle` on 2026-08-18 — if you
// need one, teach scripts/bundle.sh about it first, or the import resolves to
// nothing at build time and the type here is a promise nobody keeps.)
