# Toolkit component catalogue — concept map (proposal)

For [#845](https://github.com/nidara-project/nidara-desktop/issues/845), under
[#818](https://github.com/nidara-project/nidara-desktop/issues/818). **Draft for the owner and
Claude: every Nidara name, agent action vocabulary, risk assignment, glass eligibility and
future phase placement below is a proposal.** These are descriptive component names, not
Rust type names, a public API, an inheritance tree, or GTK/AppKit compatibility promises.
Construction remains imperative; [CONTRACT.md](CONTRACT.md) governs the existing toolkit.
This document does not amend that contract or approve implementation.

The map covers app-facing components, including Settings first and later shell/third-party
needs. GTK/AppKit models, controllers and helper objects appear only where they explain a
component; they do not imply one Nidara wrapper per foreign class. A port must preserve the
interaction and semantics, then compose the Nidara concepts. Foreign constructors, signals,
cell hierarchies, XML/nib files and layout algorithms are not a migration recipe.

## How to read the tables

- **Sources:** each linked GTK4/AppKit name cites the official page used for that mapping.
  Consulted 2026-10-17; these are current documentation pages, not a promised minimum GTK
  version. “Composition” and “approximation” are this catalogue's interpretation of those
  pages, not claims of equivalent APIs. In particular, deprecated GTK4 classes are identified
  when useful for porting, rather than recommended for new work.
- **AT-SPI role:** names below abbreviate `ATSPI_ROLE_*` from the [AT-SPI role reference][roles].
  They describe the intended provider output, not GTK accessible-role names or existing
  `nk_a11y::Role` variants. Roles alone are insufficient: names, state, relations, supported
  interfaces and events must accompany them. A structural wrapper with no meaning may be
  omitted while retaining its meaningful descendants. A pane of glass is not the AT-SPI
  `GLASS_PANE` role (which means an overlay).
- **Agent view — all proposals:** `none` means inspection/no domain mutation; `reversible`
  means a UI or domain change with a defined reversal; `destructive` means a consequential
  action that **needs the user's consent when an agent triggers it**. The row gives a
  baseline for the stated action, never blanket permission for a widget class. The app must
  declare the actual effect: a button that opens a page can be `reversible`, while one that
  deletes data is `destructive`; a switch that disables protection must not inherit a harmless
  default. If reversibility is unknown, it cannot be assumed. Inspection excludes secrets.
  No agent projection, consent mechanism or new action API is implemented by this document.
- **Glass — proposal:** `yes` means it may own a pane declared through `nidara-material-v1`,
  `no` means content/structure within another pane, and `host` means an external chooser owns
  its material. Eligibility is not a default fill or a new Wayland surface per widget. Shapes
  belong to the hosting surface; do not stack a second pane over existing glass. The contract
  currently supports root-surface glass, not glass on moving subsurfaces. The foreign
  equivalents do not imply support for our protocol.
- **Phase:** `0` means a specimen exists in `nk-phase0`, **not** a reusable/public component
  or complete implementation of the row's proposed agent view. `1` proposes foundations and
  Settings; `later` proposes subsequent shell/third-party work. Future placement needs owner
  confirmation. Phase-0 evidence is [the form][form], [its material][material], [the semantic
  roles][semantic-roles] and [their provider mapping][provider]. The existing dialog restores
  focus and fields expose invalid state; these do not establish a general alert component.

## Windows & structure

| Nidara Kit | GTK4 | AppKit | AT-SPI role | Agent view (proposal) | Glass | Phase |
|---|---|---|---|---|---|---|
| App scene **(proposal)** | [Gtk.Window], [Gtk.ApplicationWindow]; application integration is additional to a surface | [NSWindow]; [NSApplication] owns app lifetime separately | `FRAME` | Inspect title/active state: `none`; focus: `reversible`; close with unsaved loss: `destructive` | yes, root | 0 |
| Focused conversation **(proposal)** | Transient/modal [Gtk.Window]; general [Gtk.Dialog] is deprecated since 4.10 | [NSWindow] sheet or [NSPanel]; sheet attachment and modality need explicit mapping | `DIALOG` | Inspect: `none`; cancel/return focus: `reversible`; confirm consequential effect: `destructive` | yes, dialog root | 0 |
| Auxiliary workspace **(proposal)** | [Gtk.Window] composed for an auxiliary task; no promise of panel behavior parity | [NSPanel]; specialized auxiliary-window behavior | `FRAME` (or `DIALOG` for a task dialog) | Inspect: `none`; show/hide/focus: `reversible` | yes, root | later |
| Scene heading **(proposal)** | [Gtk.HeaderBar]; client titlebar content | [NSTitlebarAccessoryViewController]; accessory content, not a complete titlebar replacement | `PANEL`, named title and action children | Read title: `none`; declared child commands carry their own risk | yes, only as a distinct pane | 1 |
| Command strip **(proposal)** | [Gtk.ActionBar] or [Gtk.Box] composition; contextual/below-content placement differs | [NSToolbar]; window integration and user customization differ | `TOOL_BAR` | Inspect commands: `none`; invoke each command with its declared risk | yes, distinct pane | later |
| Split workspace **(proposal)** | [Gtk.Paned]; two panes | [NSSplitView]; two or more views, so multi-pane ports need decomposition | `SPLIT_PANE`, operable divider `SEPARATOR` | Inspect divider: `none`; resize/collapse/restore: `reversible` | no; child regions may own panes | 1 |
| Scroll region **(proposal)** | [Gtk.ScrolledWindow]; includes scrolling infrastructure | [NSScrollView]; document/clip/scroller composition | `SCROLL_PANE`, `VIEWPORT`, `SCROLL_BAR` children as applicable | Inspect visible range: `none`; scroll/reveal item: `reversible` | no | 1 |
| Scroll position control **(proposal)** | [Gtk.Scrollbar]; adjustment-backed position, not a domain slider | [NSScroller]; normally managed by a scroll view | `SCROLL_BAR` | Inspect range: `none`; set viewport position: `reversible` | no | 1 |
| Material region **(proposal)** | No dedicated equivalent in this map; [Gtk.DrawingArea] can paint a client background, not Hyalo material | [NSVisualEffectView]; translucency/vibrancy concept, not our protocol or effect parameters | `PANEL` if meaningful, otherwise omitted | Inspect semantic children: `none`; no material-edit action | yes; phase-0 root specimen only | 0 |
| Desktop anchor **(proposal)** | [Gtk.Window] alone does not provide a Wayland layer-shell role; separate platform integration required | [NSPanel] is only an auxiliary-window analogy; no Wayland layer-shell equivalent | `PANEL` or `TOOL_BAR` by actual purpose | Inspect: `none`; reveal/hide: `reversible`; embedded actions classified individually | yes; hosting surface required | later |

## Navigation

| Nidara Kit | GTK4 | AppKit | AT-SPI role | Agent view (proposal) | Glass | Phase |
|---|---|---|---|---|---|---|
| Page deck **(proposal)** | [Gtk.Stack]; switches content without a built-in selector | [NSViewController] composition; [NSTabView] offers pages but couples a tab interface | `PANEL`, visible page children | Inspect current page: `none`; select page/return: `reversible` | no | 1 |
| Section navigator **(proposal)** | [Gtk.StackSidebar] with [Gtk.Stack] | [NSOutlineView] with [NSSplitView] composition; data hierarchy is not a page-switching policy | `LIST`/`LIST_ITEM`; use `TREE`/`TREE_ITEM` only for actual hierarchy | Inspect sections: `none`; select section: `reversible` | yes, sidebar pane | 1 |
| Tab navigator **(proposal)** | [Gtk.Notebook], or [Gtk.StackSwitcher] with [Gtk.Stack]; different compositions | [NSTabView]; tab selection, not a portable close/reorder policy | `PAGE_TAB_LIST`, `PAGE_TAB` | Inspect tabs: `none`; select/reorder: `reversible`; close with unsaved loss: `destructive` | no | later |
| Segmented choice **(proposal)** | Grouped [Gtk.ToggleButton] composition | [NSSegmentedControl]; selection/tracking modes must be mapped explicitly | `GROUPING`, `RADIO_BUTTON` for exclusive choices; `TOGGLE_BUTTON` for independent toggles | Inspect selection: `none`; set selection: `reversible` unless the bound effect changes risk | no | later |
| Detail disclosure **(proposal)** | [Gtk.Expander] | [NSButton] with [disclosure bezel style][disclosure-style], plus child layout; no matching container | `TOGGLE_BUTTON`, expanded state and controlled content relation | Inspect expanded state: `none`; expand/collapse: `reversible` | no | 1 |
| History navigator **(proposal)** | [Gtk.Stack] plus app-owned history; the stack is not a history model | [NSPageController]; swipe navigation is additional behavior | `PANEL`, named back/forward `PUSH_BUTTON` children | Inspect destination: `none`; back/forward: `reversible` subject to pending-edit policy | no | later |

## Controls

| Nidara Kit | GTK4 | AppKit | AT-SPI role | Agent view (proposal) | Glass | Phase |
|---|---|---|---|---|---|---|
| Action control **(proposal)** | [Gtk.Button] | [NSButton]; target/action is not a Nidara API proposal | `PUSH_BUTTON` | Inspect label/enabled state: `none`; activate: `reversible` for opening UI, `destructive` for deletion or other consequential effects | yes, only when it has a distinct glass pane | 0 |
| Latched action **(proposal)** | [Gtk.ToggleButton] | [NSButton] with stateful [button type][button-types] | `TOGGLE_BUTTON` | Inspect state: `none`; set pressed state: `reversible`, subject to bound effect | no | later |
| Check choice **(proposal)** | [Gtk.CheckButton]; mixed state is distinct from checked | [NSButton] with checkbox [button type][button-types] | `CHECK_BOX`, checked/mixed state | Inspect: `none`; set choice: `reversible`, subject to bound effect | no | 0 |
| Exclusive choice **(proposal)** | Grouped [Gtk.CheckButton]; GTK4 has no separate radio-button class | [NSButton] with radio [button type][button-types]; group behavior must be preserved | `RADIO_BUTTON`, named `GROUPING` | Inspect group: `none`; select one option: `reversible`, subject to bound effect | no | 1 |
| On/off setting **(proposal)** | [Gtk.Switch]; requested and actual state may differ while applying | [NSSwitch]; do not silently equate delayed application behavior | `CHECK_BOX`, checked state (proposed AT-SPI projection) | Inspect actual/pending state: `none`; set on/off: `reversible`, or `destructive` for a consequential bound effect | no | 1 |
| Range setting **(proposal)** | [Gtk.Scale]; horizontal/vertical presentation | [NSSlider]; also offers a circular form, not promised here | `SLIDER`, value/range interface | Inspect value/bounds: `none`; set value: `reversible`, subject to bound effect | no | 1 |
| Number setting **(proposal)** | [Gtk.SpinButton]; integrated numeric entry and arrows | [NSStepper] plus [NSTextField]; stepper alone has no editable display | `SPIN_BUTTON`, editable text/value as applicable | Inspect bounds/step: `none`; set/increment/decrement: `reversible`, subject to bound effect | no | 1 |
| Fixed option picker **(proposal)** | [Gtk.DropDown]; [Gtk.ComboBox] is a deprecated porting reference (4.10), not the suggested new widget | [NSPopUpButton]; fixed selection, unlike editable [NSComboBox] | `COMBO_BOX`, `LIST_ITEM` options and Selection interface | Inspect choices/current value: `none`; open/choose/close: `reversible`, subject to bound effect | yes, popup pane only | 0 |
| Editable option picker **(proposal)** | [Gtk.ComboBox] with entry is a deprecated porting reference; compose [Gtk.Entry] and a choice popup for new work | [NSComboBox]; arbitrary input as well as list selection | `COMBO_BOX` with `ENTRY` and option children | Inspect nonsecret value/options: `none`; edit/choose: `reversible`, subject to bound effect | yes, popup pane only | later |
| Date choice **(proposal)** | [Gtk.Calendar]; month/date selection, not a complete time editor | [NSDatePicker]; date/time editing modes exceed a calendar | `CALENDAR`; `DATE_EDITOR` for an editable date field | Inspect supported calendar/range: `none`; set date: `reversible`, subject to bound effect | no | later |

## Text

| Nidara Kit | GTK4 | AppKit | AT-SPI role | Agent view (proposal) | Glass | Phase |
|---|---|---|---|---|---|---|
| Readable text **(proposal)** | [Gtk.Label]; optional selection/markup must be considered | Noneditable [NSTextField]; field and label share a class | `LABEL` for a control label, `STATIC` for standalone text | Read text: `none`; select/copy public text: `reversible` | no | 0 |
| Section title **(proposal)** | [Gtk.Label] with heading semantics; styling alone is insufficient | Noneditable [NSTextField] with explicit accessibility semantics | `HEADING`, level attribute | Read title/level: `none` | no | 1 |
| Text input **(proposal)** | [Gtk.Entry] | Editable [NSTextField]; formatting/validation behavior needs mapping | `ENTRY`, Text and EditableText interfaces | Read nonsecret text: `none`; focus/edit/select/undo: `reversible`; submit effect classified separately | no | 0 |
| Secret input **(proposal)** | [Gtk.PasswordEntry]; masking/copy/reveal policies need separate review | [NSSecureTextField]; does not specify Nidara's agent policy | `PASSWORD_TEXT`; retain contract redaction before projection | Inspect name/enabled state: `none`; focus: `reversible`; secret insertion route is an owner question, never a readback action | no | 0 |
| Search input **(proposal)** | [Gtk.SearchEntry] | [NSSearchField]; recent-query menus/categories are extra behavior | `ENTRY`, search purpose and result relation | Inspect nonsecret query: `none`; edit/clear/find: `reversible` | no | later |
| Plain document editor **(proposal)** | [Gtk.TextView] with plain buffer content | [NSTextView] with rich editing disabled | `TEXT`, editable state, Text/EditableText interfaces | Read document: `none`; edit/select/undo: `reversible`; discard unsaved changes: `destructive` | no | later |
| Styled document editor **(proposal)** | [Gtk.TextView]; buffer tags/embedded content, not an RTF compatibility promise | [NSTextView]; rich text and attachments exceed phase-0 editing | `TEXT`, text attributes and accessible embedded children | Read permitted content: `none`; edit/format/undo: `reversible`; irreversible discard: `destructive` | no | later |
| Resource link **(proposal)** | [Gtk.LinkButton], or links in [Gtk.Label] | [NSTextView] with [link text attributes][link-attributes]; no matching dedicated control in this mapping | `LINK`, destination/name | Inspect destination: `none`; open known resource: `reversible`; consequential external action requires its own `destructive` declaration | no | 1 |
| Symbol content **(proposal)** | [Gtk.Image]; image display is broader than symbolic icons | [NSImageView]; no implied Nidara icon-name compatibility | `IMAGE` if meaningful; decorative content omitted, control uses its own role | Inspect accessible description: `none` | no | 1 |
| Picture content **(proposal)** | [Gtk.Picture]; paintable sizing differs from icon display | [NSImageView]; editing/dragging options are not implied | `IMAGE`, description | Inspect permitted description: `none`; no default image-edit action | no | later |
| Shortcut hint **(proposal)** | [Gtk.ShortcutLabel] is deprecated since 4.18; [Gtk.Label] is a composition alternative | [NSTextField] composition; menu key equivalents are a separate concept | `LABEL`, shortcut relation/metadata on its action | Inspect binding: `none`; displaying a binding does not invoke it | no | later |

## Lists & collections

| Nidara Kit | GTK4 | AppKit | AT-SPI role | Agent view (proposal) | Glass | Phase |
|---|---|---|---|---|---|---|
| Settings group **(proposal)** | [Gtk.ListBox] for a modest row set; not a virtualized large-data list | [NSStackView] with composed row views; no direct settings-list class | `LIST`, `LIST_ITEM` children | Inspect groups/rows: `none`; navigate: `reversible`; row controls declare their own effects | no | 1 |
| Setting row **(proposal)** | [Gtk.ListBoxRow] plus [Gtk.Box], label and control composition | [NSView]/[NSStackView] composition; no built-in row with our label/help/control contract | `LIST_ITEM`, labelled embedded controls | Inspect label/help/value: `none`; activate navigation: `reversible`; embedded mutation uses its declared risk | no | 1 |
| Large item list **(proposal)** | [Gtk.ListView]; factory/model/selection split, see [list overview][gtk-lists] | Single-column [NSTableView] approximation; data-source and view reuse differ | `LIST`, `LIST_ITEM`, Selection interface | Inspect accessible item identities: `none`; select/reveal: `reversible`; delete item: `destructive` | no | later |
| Tile collection **(proposal)** | [Gtk.GridView]; model-backed item grid | [NSCollectionView]; layouts can exceed a grid | `LIST`, `LIST_ITEM`; use `TABLE` only if content has table semantics | Inspect items: `none`; select/reveal/reorder with undo: `reversible`; delete: `destructive` | no | later |
| Hierarchical collection **(proposal)** | [Gtk.TreeListModel] + [Gtk.ListView]/[Gtk.ColumnView] + [Gtk.TreeExpander]; model is not a tree widget | [NSOutlineView]; hierarchical row/column view | `TREE`/`TREE_ITEM`, or `TREE_TABLE` with cells for tabular hierarchy | Inspect hierarchy: `none`; expand/select: `reversible`; remove subtree: `destructive` | no | later |
| Data table **(proposal)** | [Gtk.ColumnView]; columns/factories and selection model | [NSTableView]; do not copy its cell/data-source hierarchy | `TABLE`, `TABLE_ROW`, `TABLE_CELL`, `TABLE_COLUMN_HEADER` | Inspect cell/headers: `none`; select/sort: `reversible`; edit with undo: `reversible`; destructive row action: `destructive` | no | later |
| Item content **(proposal)** | Child widget managed through [Gtk.ListItem]; helper object is not itself the visible widget or a durable item ID | [NSView] hosted by [NSCollectionView]/[NSTableView]; item identity belongs to the model, not a recycled view | `LIST_ITEM` or `TABLE_CELL` according to host, meaningful control children | Inspect stable model item: `none`; select: `reversible`; application commands classify their effect | no | later |
| Wrapping item group **(proposal)** | [Gtk.FlowBox]; child widgets reflow, unlike a model-backed large grid | [NSCollectionView] approximation; collection layout/data machinery differs | `LIST`, `LIST_ITEM`, or `GROUPING` if nonselectable | Inspect children: `none`; select where supported: `reversible` | no | later |

## Menus & popovers

| Nidara Kit | GTK4 | AppKit | AT-SPI role | Agent view (proposal) | Glass | Phase |
|---|---|---|---|---|---|---|
| Anchored content **(proposal)** | [Gtk.Popover]; anchored popup content, not necessarily a menu | [NSPopover]; anchor/close behavior differs | `DIALOG` for interactive transient content; `PANEL` for a nonmodal grouping | Inspect anchor/content: `none`; open/dismiss: `reversible`; content actions classified separately | yes, popup pane | later |
| Menu opener **(proposal)** | [Gtk.MenuButton]; popup or menu model | Pull-down [NSPopUpButton] approximation; distinguish commands from fixed-value selection | `PUSH_BUTTON`, popup relation and expanded state | Inspect available menu: `none`; open/close: `reversible` | no; popup may own a pane | later |
| Command menu **(proposal)** | [Gtk.PopoverMenu]; menu model/actions, not arbitrary popover content | [NSMenu]; includes context/submenu use | `POPUP_MENU` or `MENU`, `MENU_ITEM` children | Inspect enabled commands: `none`; open/navigate/dismiss: `reversible`; activation takes command risk | yes, menu pane | later |
| Menu command **(proposal)** | Menu-model entry presented by [Gtk.PopoverMenu]; not a GTK4 menu-item widget class | [NSMenuItem]; command/state/submenu mapping required | `MENU_ITEM`, `CHECK_MENU_ITEM` or `RADIO_MENU_ITEM` by behavior | Inspect label/state/shortcut: `none`; activate UI command: `reversible`; erase/replace command: `destructive` | no | later |
| App command bar **(proposal)** | [Gtk.PopoverMenuBar] in an application window | [NSMenu] with [NSApplication]; macOS app-global menu placement differs | `MENU_BAR`, menus and items | Inspect menus: `none`; open/navigate: `reversible`; each command keeps its risk | yes, host pane only | later |
| Hover explanation **(proposal)** | [Gtk.Tooltip]; often configured through widget tooltip properties | [NSView.toolTip][view-tooltip]; property, not a standalone tooltip class | `TOOL_TIP`, relation to described control | Read explanation: `none`; show/dismiss: `reversible`; no hidden command activation | yes, tooltip pane | later |

## Feedback & dialogs

| Nidara Kit | GTK4 | AppKit | AT-SPI role | Agent view (proposal) | Glass | Phase |
|---|---|---|---|---|---|---|
| Task progress **(proposal)** | [Gtk.ProgressBar]; determinate/activity modes | [NSProgressIndicator]; determinate/indeterminate modes and styles | `PROGRESS_BAR`, value/busy state as applicable | Read progress: `none`; cancellation is a separate command with its own effect | no | 1 |
| Busy signal **(proposal)** | [Gtk.Spinner]; indeterminate activity | Indeterminate [NSProgressIndicator]; not a separate spinner class | `PROGRESS_BAR`, indeterminate/busy state | Read busy state: `none`; no agent start/stop animation action | no | 1 |
| Level display **(proposal)** | [Gtk.LevelBar]; level, not editable range | [NSLevelIndicator]; read-only level feedback | `LEVEL_BAR`, value/range | Read level: `none` | no | later |
| Status badge **(proposal)** | [Gtk.Label] composition; no dedicated badge class in this mapping | Noneditable [NSTextField] composition; no dedicated badge class in this mapping | `STATIC`, or `STATUS_BAR` for changing status | Read status: `none`; no default action | no | 1 |
| Inline feedback **(proposal)** | [Gtk.Label] plus field invalid/description relation; not a label style alone | [NSTextField] plus explicit field relation; validation policy is app-owned | `STATIC` or `ALERT` for urgent feedback, related to invalid field | Read message/affected field: `none`; focus correction field: `reversible` | no | 1 |
| Message decision **(proposal)** | [Gtk.AlertDialog] (4.10+); asynchronous helper, not a widget subclass | [NSAlert]; sheet/app-modal modes differ | `ALERT` or `DIALOG`, named response buttons | Inspect message/effects: `none`; cancel: `reversible`; confirm destructive consequence: `destructive` with user consent | yes, dialog root | 1 |
| File source request **(proposal)** | [Gtk.FileDialog] open/select-folder (4.10+); chooser invocation rather than embedded widget | [NSOpenPanel]; system-owned selection flow | `FILE_CHOOSER` in chooser provider, launcher `PUSH_BUTTON` in app | Inspect filters: `none`; request/select/cancel: `reversible`; subsequent processing has its own effect | host; portal chooser | 1 |
| File destination request **(proposal)** | [Gtk.FileDialog] save (4.10+) | [NSSavePanel]; choosing a destination is distinct from writing bytes | `FILE_CHOOSER` in chooser provider, launcher `PUSH_BUTTON` in app | Choose/cancel destination: `reversible`; overwrite existing data: `destructive` with user consent | host; portal chooser | later |
| Color choice **(proposal)** | [Gtk.ColorDialog] (4.10+); asynchronous chooser | [NSColorPanel]; shared panel and live changes differ from a dialog result | `COLOR_CHOOSER`, launcher `PUSH_BUTTON` | Inspect current color: `none`; preview/select/cancel with restoration: `reversible`, subject to bound effect | yes, kit-owned chooser root | 1 |
| Font choice **(proposal)** | [Gtk.FontDialog] (4.10+); family/face/font variants | [NSFontPanel]; font-manager/shared-panel model differs | `FONT_CHOOSER`, launcher `PUSH_BUTTON` | Inspect font: `none`; preview/select/cancel with restoration: `reversible`, subject to bound effect | yes, kit-owned chooser root | 1 |
| App information **(proposal)** | [Gtk.AboutDialog] | [NSApplication standard About panel][about-panel]; method rather than an About subclass | `DIALOG`, labelled information and links | Read metadata: `none`; close: `reversible`; links keep their own action declaration | yes, dialog root | 1 |

## Layout

| Nidara Kit | GTK4 | AppKit | AT-SPI role | Agent view (proposal) | Glass | Phase |
|---|---|---|---|---|---|---|
| Linear arrangement **(proposal)** | [Gtk.Box]; row/column arrangement | [NSStackView]; constraint-backed arrangement, not the kit's algorithm | `PANEL`/`GROUPING` if meaningful, otherwise omitted | Inspect meaningful descendants: `none`; no direct layout mutation | no | 1 |
| Centered arrangement **(proposal)** | [Gtk.CenterBox]; start/center/end arrangement | [NSStackView] plus [NSLayoutConstraint] composition; no identical three-slot container | `PANEL` if meaningful, otherwise omitted | Inspect descendants: `none` | no | 1 |
| Cell arrangement **(proposal)** | [Gtk.Grid]; geometry, unlike a data table | [NSGridView]; layout cells, not collection virtualization | `PANEL`/`GROUPING` if meaningful; no automatic `TABLE` role | Inspect descendants: `none` | no | 1 |
| Overlaid arrangement **(proposal)** | [Gtk.Overlay]; main child plus overlaid children | [NSView] subview composition; sizing/z-order policy must be supplied | `LAYERED_PANE` if meaningful, otherwise omitted | Inspect exposed children: `none`; actions belong to children | no; child pane eligibility checked separately | 1 |
| Named group **(proposal)** | [Gtk.Frame]; decorative boundary plus optional label | [NSBox]; titled visual grouping | `GROUPING`, accessible name and children | Inspect group/name: `none` | yes, distinct group pane only | 1 |
| Content divider **(proposal)** | [Gtk.Separator] | [NSBox] [separator form][box-separator] | `SEPARATOR`; decorative-only divider may be omitted | Inspect grouping boundary: `none`; no action | no | 1 |
| Flexible space **(proposal)** | Expanding empty [Gtk.Box] composition | Empty [NSView] plus [NSLayoutConstraint] composition | Omitted; no meaningful content | No declared actions: `none` | no | 1 |
| Constrained arrangement **(proposal)** | [Gtk.ConstraintLayout]; relationship-based geometry | [NSLayoutConstraint]; solver integration differs | Omitted wrapper or `PANEL` if meaningful | Inspect meaningful descendants: `none`; constraints are not agent actions | no | 1 |
| Positioned arrangement **(proposal)** | [Gtk.Fixed]; no automatic layout, with localization/resizing caveats | [NSView] frame positioning; not a general responsive-layout substitute | `PANEL` if meaningful, otherwise omitted | Inspect descendants: `none`; app-defined geometry editing requires a separate action | no | later |
| Visibility transition **(proposal)** | [Gtk.Revealer]; client-side child transition | [NSView] animation composition; no matching reveal container in this mapping | Meaningful child roles; hidden state follows actual availability | Inspect visible state: `none`; show/hide: `reversible`; no direct animation-clock action | no; moving-layer glass remains outside phase 0 | later |
| Custom drawing content **(proposal)** | [Gtk.DrawingArea]; custom Cairo content | [NSView] subclass; drawing is not automatic accessibility | `DRAWING_AREA` or domain-specific roles with meaningful children | Inspect semantic description: `none`; domain-specific operations declare their own risks | no; material region is separate | later |

## What neither framework supplies as our combined contract — owner questions

These are questions about Nidara's requirements, not claims that GTK/AppKit lack IDs,
actions or accessibility. GTK has [builder IDs][builder-id] and [actions][gtk-actions]; AppKit
has [interface identifiers][appkit-ids], [button target/action][NSButton] and [accessibility
properties/actions][appkit-a11y]. Those mechanisms do not, by themselves, specify the proposed
Nidara agent contract or speak Hyalo's protocols.

1. **Owner question — stable agent identity:** should the existing window-lifetime semantic
   node IDs gain app-scoped, developer-declared identifiers that survive view recycling and
   page reconstruction? Which lifetime, uniqueness and stale-target rejection rules should
   a porting agent rely on? No persistence across launches is decided here.
   **Owner, 2026-10-17: open.** The options still need weighing; nothing is decided.
2. **Owner question — declared effects and consent:** should every agent action declare typed
   arguments, preconditions, effect, risk, undo behavior and completion/error outcome? Who
   assigns and verifies risk, and how is a user's consent bound to the exact destructive
   target/action/value without reuse after the UI changes?
   **Owner, 2026-10-17: probably yes, not final.** The owner's direction: bind `destructive`
   actions to the permissions the user already grants in Settings → AI (the
   `allowComputerControl` family of gates), so consent has one home. How it binds to an
   exact target and value is still open.
3. **Owner question — one tree, different readers:** how should screen-reader semantics be
   projected to agents while preserving the contract's password redaction, stable identity
   and event ordering? Should secret insertion require a separate user-mediated path, and
   what permitted metadata can an agent inspect? No secret readback is proposed.
   **Owner, 2026-10-17: confirmed.** One semantic tree, two views: AT-SPI and agents. The
   projection details above are still to be designed.
4. **Owner question — Hyalo presentation:** how should app-level components declare glass,
   motion and anchors while preserving presented-position hit-testing and IME placement?
   Neither foreign class map is a specification for `nidara-material-v1`/`nidara-layers-v1`;
   their existing rules remain in [CONTRACT.md](CONTRACT.md) and the protocol XMLs.
   **Owner, 2026-10-17: tentatively, as the shell does.** A component declares its shapes and
   Hyalo paints the glass; the app never paints it. Not final.

## Portability — confirmed by the owner (2026-10-17)

**Principle: “works on any Wayland compositor; best on Hyalo.”** Where
`nidara-material-v1` is missing or unavailable, a pane would fall back to an **opaque
material**, keeping text, contrast, focus indication and semantics usable. The principle is
confirmed for the future kit, but it is not current compatibility evidence: phase 0 targets
Hyalo and its [native transport][transport] has not established that promise on other
compositors.

The standard-protocol baseline and capability negotiation still need deciding before this
becomes a contract. Material fallback alone cannot replace Hyalo layer motion, private window
controls, or shell anchoring; their fallback behavior or explicit unavailability needs a
separate decision. No client animation implementation, alternative glass renderer or foreign
compositor support is approved by this catalogue.

## Sources and phase-0 evidence

GTK4 and AppKit citations are attached directly to the concepts above; reference links below
resolve to the specific official pages consulted. AppKit content was read from Apple's
corresponding DocC JSON (`/tutorials/data/documentation/appkit/….json`); links point to the
public documentation pages. AT-SPI role spelling comes from its upstream reference, and
Nidara existence claims come from repository sources rather than analogy with either kit.

[roles]: https://docs.gtk.org/atspi2/enum.Role.html
[gtk-lists]: https://docs.gtk.org/gtk4/section-list-widget.html
[gtk-actions]: https://docs.gtk.org/gtk4/actions.html
[builder-id]: https://docs.gtk.org/gtk4/method.Buildable.get_buildable_id.html
[appkit-ids]: https://developer.apple.com/documentation/appkit/nsuserinterfaceitemidentification
[appkit-a11y]: https://developer.apple.com/documentation/appkit/nsaccessibilityprotocol
[disclosure-style]: https://developer.apple.com/documentation/appkit/nsbutton/bezelstyle-swift.enum/disclosure
[box-separator]: https://developer.apple.com/documentation/appkit/nsbox/boxtype-swift.enum/separator
[button-types]: https://developer.apple.com/documentation/appkit/nsbutton/buttontype
[link-attributes]: https://developer.apple.com/documentation/appkit/nstextview/linktextattributes
[view-tooltip]: https://developer.apple.com/documentation/appkit/nsview/tooltip
[about-panel]: https://developer.apple.com/documentation/appkit/nsapplication/orderfrontstandardaboutpanel(_:)
[form]: phase0/src/form.rs
[material]: phase0/src/material.rs
[semantic-roles]: crates/nk-a11y/src/lib.rs
[provider]: crates/nk-a11y/src/atspi_backend.rs
[transport]: crates/nk-wayland/src/lib.rs

[Gtk.AboutDialog]: https://docs.gtk.org/gtk4/class.AboutDialog.html
[Gtk.ActionBar]: https://docs.gtk.org/gtk4/class.ActionBar.html
[Gtk.AlertDialog]: https://docs.gtk.org/gtk4/class.AlertDialog.html
[Gtk.ApplicationWindow]: https://docs.gtk.org/gtk4/class.ApplicationWindow.html
[Gtk.Box]: https://docs.gtk.org/gtk4/class.Box.html
[Gtk.Button]: https://docs.gtk.org/gtk4/class.Button.html
[Gtk.Calendar]: https://docs.gtk.org/gtk4/class.Calendar.html
[Gtk.CenterBox]: https://docs.gtk.org/gtk4/class.CenterBox.html
[Gtk.CheckButton]: https://docs.gtk.org/gtk4/class.CheckButton.html
[Gtk.ColorDialog]: https://docs.gtk.org/gtk4/class.ColorDialog.html
[Gtk.ColumnView]: https://docs.gtk.org/gtk4/class.ColumnView.html
[Gtk.ComboBox]: https://docs.gtk.org/gtk4/class.ComboBox.html
[Gtk.ConstraintLayout]: https://docs.gtk.org/gtk4/class.ConstraintLayout.html
[Gtk.Dialog]: https://docs.gtk.org/gtk4/class.Dialog.html
[Gtk.DrawingArea]: https://docs.gtk.org/gtk4/class.DrawingArea.html
[Gtk.DropDown]: https://docs.gtk.org/gtk4/class.DropDown.html
[Gtk.Entry]: https://docs.gtk.org/gtk4/class.Entry.html
[Gtk.Expander]: https://docs.gtk.org/gtk4/class.Expander.html
[Gtk.FileDialog]: https://docs.gtk.org/gtk4/class.FileDialog.html
[Gtk.Fixed]: https://docs.gtk.org/gtk4/class.Fixed.html
[Gtk.FlowBox]: https://docs.gtk.org/gtk4/class.FlowBox.html
[Gtk.FontDialog]: https://docs.gtk.org/gtk4/class.FontDialog.html
[Gtk.Frame]: https://docs.gtk.org/gtk4/class.Frame.html
[Gtk.Grid]: https://docs.gtk.org/gtk4/class.Grid.html
[Gtk.GridView]: https://docs.gtk.org/gtk4/class.GridView.html
[Gtk.HeaderBar]: https://docs.gtk.org/gtk4/class.HeaderBar.html
[Gtk.Image]: https://docs.gtk.org/gtk4/class.Image.html
[Gtk.Label]: https://docs.gtk.org/gtk4/class.Label.html
[Gtk.LevelBar]: https://docs.gtk.org/gtk4/class.LevelBar.html
[Gtk.LinkButton]: https://docs.gtk.org/gtk4/class.LinkButton.html
[Gtk.ListBox]: https://docs.gtk.org/gtk4/class.ListBox.html
[Gtk.ListBoxRow]: https://docs.gtk.org/gtk4/class.ListBoxRow.html
[Gtk.ListItem]: https://docs.gtk.org/gtk4/class.ListItem.html
[Gtk.ListView]: https://docs.gtk.org/gtk4/class.ListView.html
[Gtk.MenuButton]: https://docs.gtk.org/gtk4/class.MenuButton.html
[Gtk.Notebook]: https://docs.gtk.org/gtk4/class.Notebook.html
[Gtk.Overlay]: https://docs.gtk.org/gtk4/class.Overlay.html
[Gtk.Paned]: https://docs.gtk.org/gtk4/class.Paned.html
[Gtk.PasswordEntry]: https://docs.gtk.org/gtk4/class.PasswordEntry.html
[Gtk.Picture]: https://docs.gtk.org/gtk4/class.Picture.html
[Gtk.Popover]: https://docs.gtk.org/gtk4/class.Popover.html
[Gtk.PopoverMenu]: https://docs.gtk.org/gtk4/class.PopoverMenu.html
[Gtk.PopoverMenuBar]: https://docs.gtk.org/gtk4/class.PopoverMenuBar.html
[Gtk.ProgressBar]: https://docs.gtk.org/gtk4/class.ProgressBar.html
[Gtk.Revealer]: https://docs.gtk.org/gtk4/class.Revealer.html
[Gtk.Scale]: https://docs.gtk.org/gtk4/class.Scale.html
[Gtk.Scrollbar]: https://docs.gtk.org/gtk4/class.Scrollbar.html
[Gtk.ScrolledWindow]: https://docs.gtk.org/gtk4/class.ScrolledWindow.html
[Gtk.SearchEntry]: https://docs.gtk.org/gtk4/class.SearchEntry.html
[Gtk.Separator]: https://docs.gtk.org/gtk4/class.Separator.html
[Gtk.ShortcutLabel]: https://docs.gtk.org/gtk4/class.ShortcutLabel.html
[Gtk.SpinButton]: https://docs.gtk.org/gtk4/class.SpinButton.html
[Gtk.Spinner]: https://docs.gtk.org/gtk4/class.Spinner.html
[Gtk.Stack]: https://docs.gtk.org/gtk4/class.Stack.html
[Gtk.StackSidebar]: https://docs.gtk.org/gtk4/class.StackSidebar.html
[Gtk.StackSwitcher]: https://docs.gtk.org/gtk4/class.StackSwitcher.html
[Gtk.Switch]: https://docs.gtk.org/gtk4/class.Switch.html
[Gtk.TextView]: https://docs.gtk.org/gtk4/class.TextView.html
[Gtk.ToggleButton]: https://docs.gtk.org/gtk4/class.ToggleButton.html
[Gtk.Tooltip]: https://docs.gtk.org/gtk4/class.Tooltip.html
[Gtk.TreeExpander]: https://docs.gtk.org/gtk4/class.TreeExpander.html
[Gtk.TreeListModel]: https://docs.gtk.org/gtk4/class.TreeListModel.html
[Gtk.Window]: https://docs.gtk.org/gtk4/class.Window.html
[NSAlert]: https://developer.apple.com/documentation/appkit/nsalert
[NSApplication]: https://developer.apple.com/documentation/appkit/nsapplication
[NSBox]: https://developer.apple.com/documentation/appkit/nsbox
[NSButton]: https://developer.apple.com/documentation/appkit/nsbutton
[NSCollectionView]: https://developer.apple.com/documentation/appkit/nscollectionview
[NSColorPanel]: https://developer.apple.com/documentation/appkit/nscolorpanel
[NSComboBox]: https://developer.apple.com/documentation/appkit/nscombobox
[NSDatePicker]: https://developer.apple.com/documentation/appkit/nsdatepicker
[NSFontPanel]: https://developer.apple.com/documentation/appkit/nsfontpanel
[NSGridView]: https://developer.apple.com/documentation/appkit/nsgridview
[NSImageView]: https://developer.apple.com/documentation/appkit/nsimageview
[NSLayoutConstraint]: https://developer.apple.com/documentation/appkit/nslayoutconstraint
[NSLevelIndicator]: https://developer.apple.com/documentation/appkit/nslevelindicator
[NSMenu]: https://developer.apple.com/documentation/appkit/nsmenu
[NSMenuItem]: https://developer.apple.com/documentation/appkit/nsmenuitem
[NSOpenPanel]: https://developer.apple.com/documentation/appkit/nsopenpanel
[NSOutlineView]: https://developer.apple.com/documentation/appkit/nsoutlineview
[NSPageController]: https://developer.apple.com/documentation/appkit/nspagecontroller
[NSPanel]: https://developer.apple.com/documentation/appkit/nspanel
[NSPopUpButton]: https://developer.apple.com/documentation/appkit/nspopupbutton
[NSPopover]: https://developer.apple.com/documentation/appkit/nspopover
[NSProgressIndicator]: https://developer.apple.com/documentation/appkit/nsprogressindicator
[NSSavePanel]: https://developer.apple.com/documentation/appkit/nssavepanel
[NSScrollView]: https://developer.apple.com/documentation/appkit/nsscrollview
[NSScroller]: https://developer.apple.com/documentation/appkit/nsscroller
[NSSearchField]: https://developer.apple.com/documentation/appkit/nssearchfield
[NSSecureTextField]: https://developer.apple.com/documentation/appkit/nssecuretextfield
[NSSegmentedControl]: https://developer.apple.com/documentation/appkit/nssegmentedcontrol
[NSSlider]: https://developer.apple.com/documentation/appkit/nsslider
[NSSplitView]: https://developer.apple.com/documentation/appkit/nssplitview
[NSStackView]: https://developer.apple.com/documentation/appkit/nsstackview
[NSStepper]: https://developer.apple.com/documentation/appkit/nsstepper
[NSSwitch]: https://developer.apple.com/documentation/appkit/nsswitch
[NSTabView]: https://developer.apple.com/documentation/appkit/nstabview
[NSTableView]: https://developer.apple.com/documentation/appkit/nstableview
[NSTextField]: https://developer.apple.com/documentation/appkit/nstextfield
[NSTextView]: https://developer.apple.com/documentation/appkit/nstextview
[NSTitlebarAccessoryViewController]: https://developer.apple.com/documentation/appkit/nstitlebaraccessoryviewcontroller
[NSToolbar]: https://developer.apple.com/documentation/appkit/nstoolbar
[NSView]: https://developer.apple.com/documentation/appkit/nsview
[NSViewController]: https://developer.apple.com/documentation/appkit/nsviewcontroller
[NSVisualEffectView]: https://developer.apple.com/documentation/appkit/nsvisualeffectview
[NSWindow]: https://developer.apple.com/documentation/appkit/nswindow
