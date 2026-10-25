# Native header search (#915)

The SearchInput in the 200×32 header pill is an editable combo. Typing shows up to
8 matches, with the destination page under each row result, followed by View all
(N). Page results do not repeat their own name. Up/Down move the highlighted active
option; Enter opens it; Escape dismisses the list and preserves the query. IME
composition has priority over those keys. The content stays put while typing.

View all mounts an ordinary Settings results page using existing rows. It retains
the complete match set, independently of the suggestion limit. Back restores
Appearance; row selection uses the existing explicit native/legacy page router.
Opening search, results or a page performs no Config1 Apply. Pending page resources
are unmounted normally when results replace Appearance.

The index reads the same exported page names and custom/disclosure labels, plus
available Config1 row titles/subtitles. Unavailable registry rows are excluded.
Builder-owned runtime objects that supply neither registry nor manifest labels
(e.g. discovered sound-card objects) are not indexed yet; this is not full legacy
search parity. English/Spanish labels for results and View all are exported normally;
other locales use the existing English fallback.

The reusable component is nk-widgets::suggestions::Suggestions. It keeps one real
editor and uses the existing MenuList in a nonmodal xdg popup on nk-wayland's
parent connection/queue. It introduces no new host, protocol XML, workflow step or
per-PR gate. The popup has its own acknowledged geometry, scale, frame callbacks
and released buffers. Typing and IME stay on the original header capsule surface.

The parent provider publishes one editable ComboBox, ListBox, option selection and
ActiveDescendantChanged. It rejects old request revisions; keyboard focus remains
on the editor. Real-session AT-SPI inspection verifies these interfaces and actual
option events. This does not claim Orca speech acceptance or a real-engine IME
matrix on the new header/popup; #946's generic input evidence does not cover it.

Local real-session evidence and the bounded observer/exercise scripts live under
`toolkit/target/header-20261025/` in the 915-d7-header worktree. They target the exact
own-client PID, use existing Nidara gates for keyboard/screenshots, and never edit
a setting. The native sequence checks 8+all, Down/Up, Escape preserving both query
and content, Enter opening results, and the observed AT-SPI Back action restoring
Appearance. CPU and log-growth samples distinguish idle from interaction.
