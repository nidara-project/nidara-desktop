/**
 * Nidara — geometry tokens as NUMBERS (single source of truth for Cairo & layout)
 *
 * Cairo painters and NidaraScrolled's corner geometry cannot read a CSS custom
 * property — a corner that clips has to be known in px — so the radius ladder
 * exists twice: here as numbers, and in `styles/_base.scss` as `--nidara-radius-*`.
 * **The two are mirrors and must move together.** `_base.scss` carries a comment
 * pointing back at this file.
 *
 * A radius ladder is MULTIPLICATIVE, not additive: it is deliberately NOT on the
 * 4px spacing scale (see `$space-*`), because what matters is the ratio between
 * rungs, not a shared divisor. Every mature system does the same (Material 3
 * ends its ladder on 28; Tailwind's has a 6). `sm` in particular is derived, not
 * chosen: a `.nidara-row` sits 5px inside a `.nidara-list` (1px border + 3px
 * padding + 1px margin), and the concentric radius for a 16px card at that inset
 * is 11 — the ladder's 10 is that value, rounded to the rung. Change the card's
 * padding and `sm` has to be re-derived, or the nested corners stop being
 * parallel.
 */

export const RADIUS = {
    /** chip, badge, segmented button */
    xs: 6,
    /** button, input, dropdown, list row */
    sm: 10,
    /** card inside a window (settings group, sidebar capsule) */
    md: 16,
    /** window chrome, and any floating popup of the shell (system menu, bar
     *  expansion panel, CC context menu) */
    lg: 24,
    /** island / overlay sitting directly on the wallpaper (all five island modes,
     *  app grid, Prism, notification cards, CC islands) — the widest surface in
     *  the shell uses this too: radius does NOT scale with the surface here. */
    xl: 32,
} as const

/**
 * A surface that runs a `NidaraScrolled` flush into its own corner must pass its
 * radius as `cornerRadius`, or the arc clips the pill (`cornerClearFor` in
 * `nidara-kit/scrolled.ts` does the maths: lg eats 11px, xl eats 15px).
 */

/**
 * How far a row's hover fill sits from a surface's **VISIBLE** edge — on all four
 * sides, and derived from **the corner it actually sits in**, radius *and* exponent:
 *
 *     d = (k(n)·R − k(2)·rowRadius) / k(2),   k(n) = √2·(1 − 2^(−1/n))
 *
 * The goal is one gap: the fill should stand as far from the corner's curve as it
 * does from the straight edge. `k(n)·R` is how far a `drawSquircle` corner reaches
 * along its 45° diagonal (its path is `|x/R|ⁿ + |y/R|ⁿ = 1`, so the diagonal point
 * is `R·2^(−1/n)` from the corner centre), and `k(2)·r` is the same for the row's
 * own circular CSS corner. For a real circle it collapses to plain concentricity,
 * `d = R − r`, the same rule that derives `sm` from the `.nidara-list` inset.
 *
 * **The exponent is not a footnote — it moves the answer more than the radius does.**
 * At `lg` 24 a circular corner asks for 14 and an `n: 3.2` squircle for 6, because a
 * squircle is nearly square and simply does not intrude. Feeding every `lg` surface
 * the circular answer is what made the system menu and the CC panels read as too
 * airy (user-caught 2026-08-03, third round) while the circular-cornered bubbles at
 * the same formula looked right. Pass the `n` the surface is painted with:
 * `SquircleContainer` defaults to 3.2, `perfect: true` means 2, `GlassBubble` draws
 * `cr.arc` (2), and a CSS `border-radius` is 2.
 *
 * **The row's radius is the fixed side of the equation, not the free one.** Varying
 * a row's corner per container would make the same menu row look different in the
 * dock and in the system menu — a worse inconsistency than any halo. Rows stay at
 * `sm`; the container yields.
 *
 * Uniform on all four sides, too. The three-tier container padding
 * (`design-system.md`) puts +4 on the horizontal, which is right while the padding
 * is a *text* inset — but once a child's fill spans the container, the padding is
 * the FILL'S MARGIN, and a halo twice as wide at the sides as at the ends reads as
 * a mistake (it was 12/6; no menu system runs 2:1 — AppKit ~5/4, Windows 11
 * flyouts 4/4). The text's own breathing room lives on the row.
 *
 * ⚠️ Measured from the GLASS, not from the widget rect: `SquircleContainer` paints
 * the glass `GLASS_INSET` (2px) inside its allocation, so a box aligned to the rect
 * is that much closer to the visible edge than it looks in the source. Callers
 * write `rowInsetFor(...) + GLASS_INSET` and say so — that discrepancy is what left
 * the system menu 2px tighter than its siblings while its comment claimed parity.
 */
const cornerReach = (n: number) => Math.SQRT2 * (1 - Math.pow(2, -1 / n))


/**
 * Canonical glass tint colors for all surfaces (Cairo painters & CSS token engine).
 *
 * Dark mode uses an Apple HIG / macOS Vibrancy-inspired Deep Slate (#161622 / RGB 22, 22, 34):
 * a dark base with a subtle cool undertone that provides material body, avoids
 * muddy/dirty color degradation on warm or complex wallpapers, and unifies Cairo
 * surfaces (Bar/Dock/CC/Island) with CSS windows (Settings/About).
 *
 * ⚠️ THE FLOATS AND THE STRINGS MUST NAME THE SAME COLOUR. They are two encodings
 * of one value for two consumers — the Cairo painters destructure `{r,g,b}`, the
 * CSS token engine (`core/NidaraTheme.ts`) reads `rgb`/`hex` — and nothing checks
 * that they agree. `light` shipped as `{1,1,1}` + `#fafafa` from the day this token
 * was born (#223) until 2026-08-23: light glass was pure white in Cairo and
 * `#fafafa` in CSS, in exactly the place the Deep Slate pass was unifying, and
 * every comment that cited "canonical GLASS_TINT.light (#fafafa)" was describing
 * the strings rather than the value being painted. `#fafafa` won because it is what
 * the CSS half had always shipped (it predates the token) and because light
 * vibrancy is off-white in the prior art we follow — pure white has no material.
 *
 * ⚠️ ~~`light` MUST STAY ABOVE 0.8, because `drawSquircle` infers the mode by sniffing
 * the fill (`color.r > 0.8 && …`).~~ **STALE — the sniff is gone.** #234 unified the two
 * rim ramps into one that does not know what mode it is in, and #242 then deleted the
 * inference `drawSquircle` was using it for. There is no threshold left to fall under;
 * `light` is free to be any value the design wants. Struck through rather than deleted
 * because the warning outlived the mechanism by a day and the next reader deserves to
 * know it was a real constraint, not a mistake.
 *
 * ⚠️ This is NOT the rim's white. A specular highlight is the colour of the LIGHT,
 * not of the surface: see `GLASS_SPECULAR`.
 */
export const GLASS_TINT = {
    dark: {
        r: 22 / 255,
        g: 22 / 255,
        b: 34 / 255,
        rgb: "22, 22, 34",
        hex: "#161622",
    },
    light: {
        r: 250 / 255,
        g: 250 / 255,
        b: 250 / 255,
        rgb: "250, 250, 250",
        hex: "#fafafa",
    },
} as const

/**
 * The key light — the white the glass REFLECTS, in the rim ramps and the top bevel
 * bloom (`common/DrawingUtils.ts`, `common/GlassBubble.ts`).
 *
 * It is pure white and it is deliberately its own token rather than a reuse of
 * `GLASS_TINT.light`, which is what the painters read before 2026-08-23. Those are
 * two different quantities that merely happened to share a number: one is the tint
 * of the material, the other is the colour of the light falling on it. Tied
 * together, retinting the light-mode surface would have dimmed the highlight on
 * every DARK capsule in the desktop — a change nobody asked for, in the mode almost
 * everyone runs, arriving as a side effect of an unrelated edit.
 */
export const GLASS_SPECULAR = { r: 1, g: 1, b: 1 } as const

/**
 * CHROME INK — the alpha of a neutral mark painted ON the glass, as opposed to the
 * alpha OF the glass.
 *
 * ⚠️ This is NOT `appearance.barOpacity` / `overlayOpacity` / `dockOpacity`. Those
 * are the Appearance sliders, and they are the pane: `SquircleContainer` fills a CC
 * island at `Theme.overlayOpacity`, `GlassBubble` at `max(overlayOpacity, 0.38)`,
 * the notification cards at `overlayOpacity * depth`. What follows is drawn on top of
 * that pane, and it deliberately does NOT scale with it — they would compound, and
 * the emptier the user made a surface the harder its contents would be to read. The
 * slider says how much wallpaper comes through; the ink has to stay legible at every
 * setting of it. Same reasoning that keeps `GLASS_SPECULAR` off `GLASS_TINT`: two
 * quantities that merely live near each other.
 *
 * Every one of these is painted as `Theme.chromeIsDark ? 1 : 0` at the alpha below —
 * white ink on dark chrome, black on light — so a painter that hardcodes a colour
 * here is a painter that vanishes in one of the two appearances.
 *
 * These exist because there was nowhere for them to live. Each Cairo painter kept its
 * own literal, so nothing could compare them, and `widgets/cpu-memory.ts` ended up
 * drawing THE SAME resource ring at 0.12/0.8 in the bar and 0.14/0.88 in the Control
 * Centre — one file, one element, two sets of numbers, from a redesign (24258bd5)
 * that wrote a second drawer and never looked at the first.
 *
 * NOT here, on purpose: `PulseDots`'s idle dot (0.22) is a one-of-a-kind mark with no
 * twin anywhere, and a single-use number in a shared file advertises a sharing that
 * does not exist. Neither is `WorkspaceSchematic`'s `WP_SCRIM`/`NO_WP_FILL`: a scrim
 * over a wallpaper IMAGE is not ink on glass, and both are already named where they
 * are used.
 */
export const INK = {
    /** The mark itself — the battery's outline, the dock's running dot, a resource
     *  ring's filled arc, the island player's EQ bars. Reads as content, not as
     *  decoration.
     *
     *  0.9 and not less, and the battery is where that was settled: the Lucide icons
     *  beside it in the bar stroke at FULL opacity (`.bar-left image` attenuates
     *  nothing), so at true icon scale a half-alpha 1.33px stroke reads as a
     *  washed-out hairline and the glyph looks SMALLER than neighbours whose ink box
     *  is the same width. Chrome ink sits just under the icon set, not half of it. */
    solid: 0.9,
    /** The track a solid mark runs on: a ring's unfilled remainder. A thin stroke,
     *  so it takes a much lower alpha than a filled area does to read the same. */
    track: 0.12,
    /** A filled AREA standing in for content that is absent — the cover art's empty
     *  slot. Lower than `track` despite reading stronger, because area beats stroke:
     *  the same alpha over 62×62 px is far more present than over a 2px arc. */
    wash: 0.1,
} as const

/**
 * The lockscreen / greeter GLASS, as premultiplied 0..1 components.
 *
 * ⚠️ MIRROR of `--nidara-glass`, `--nidara-glass-border` and
 * `--nidara-glass-border-sm` in `ui/greeter/style.scss` — the two files move
 * TOGETHER, exactly like RADIUS above and `--nidara-radius-*`.
 *
 * The duplication is not laziness, it is the same constraint twice: the greeter
 * draws these capsules in CSS (it gets compositor blur from the
 * `nidara-greeter` layer_rule), while the lockscreen has to PAINT them — under
 * ext-session-lock-v1 the compositor draws nothing behind the lock surface, so
 * `widget/GlassBackdrop.ts` blurs its own copy of the wallpaper. A Cairo/GSK
 * painter cannot read a CSS custom property, so the values have to exist as
 * numbers somewhere; what was wrong before is that "somewhere" was three
 * hand-typed literals at the top of the painter, with nothing but a comment
 * tying them to the stylesheet.
 *
 * These live in `ui/lib/` rather than in the lockscreen bundle because that is
 * the half of the mirror both surfaces can see.
 */
export const LOCK_GLASS = {
    /** Body fill, over the blurred backdrop. `--nidara-glass`. Synchronized with GLASS_TINT.dark.
     *
     *  ⚠️ 0.55 → 0.24 on 2026-08-24, and the number is not free-standing: it is the SHELL's
     *  `GLASS_RANGE.min` (ui/shell/core/NidaraTheme.ts), so the login screen wears the same
     *  material as the desktop at its thinnest rather than a heavier one nobody chose.
     *
     *  It moves as a PAIR with the greeter layer's `ignore_alpha` (config/greetd/
     *  hyprland-greeter.lua, now 0.23 like the shell's surfaces). Alone, either one breaks
     *  the other silently: a threshold at or above the glass means Hyprland stops blurring
     *  that layer entirely — no error, no crash, just a flat login screen nobody is diffing.
     *  `scripts/ci/blur-threshold-check.mjs` reads both and is the only thing that notices.
     *
     *  ⚠️ MIRRORED as `--nidara-glass` in ui/greeter/style.scss. Change one, change the other. */
    fill: { r: GLASS_TINT.dark.r, g: GLASS_TINT.dark.g, b: GLASS_TINT.dark.b, a: 0.24 },
    /** 1px rim, primary controls. `--nidara-glass-border`. */
    rimStrong: { r: 1, g: 1, b: 1, a: 0.22 },
    /** 1px rim, everything else — the shell's `--nidara-edge` colour exactly. */
    rimSubtle: { r: 1, g: 1, b: 1, a: 0.14 },
} as const

export const rowInsetFor = (surfaceRadius: number, n: number = 3.2, rowRadius: number = RADIUS.sm) =>
    Math.max(4, Math.round((cornerReach(n) * surfaceRadius - cornerReach(2) * rowRadius) / cornerReach(2)))


/**
 * WINDOW_LAYOUT — the geometry law of a `NidaraWindow` (sidebar + content).
 *
 * ## The law
 *
 * **The content pane is a CONSTANT width.** Not a maximum, not a band: 800px, on
 * every page, in every locale, at every text scale. Making the window wider adds
 * empty margin around it and nothing else. Narrowing it first spends that margin,
 * then makes the sidebar float (`collapseAt`), and then hits the window's minimum.
 *
 * Stated as a function of the width W available INSIDE the glass rim (which is
 * what the split view measures — a window is `W + 2·glassRim` wide), with
 * S = `sidebar`, C = `content`:
 *
 *     W ≥ S + C   →  sidebar DOCKED,   content C, centred in W − S
 *     C ≤ W < S+C →  sidebar FLOATING, content C, centred in W
 *     F ≤ W < C   →  sidebar FLOATING, content W — the pane YIELDS rather than
 *                    let the window's edge cut a row's trailing control off
 *                    (`contentFloor`, below)
 *     W < F       →  refused (`set_size_request`); a compositor that forces it
 *                    anyway gets horizontal SCROLL, not a clip
 *
 * It is continuous: at W = S + C both branches give the same content width, so
 * the sidebar leaving does not resize the page under the pointer. That exactness
 * is why the comparison is in rim-space and not window-space: at W = S + C the
 * docked pane gets exactly C, and shaving 2px off the breakpoint to make the
 * number rounder would hand it C − 2 and start the page scrolling sideways.
 *
 * ## Why constant, and why 800
 *
 * The predecessor had a maximum (800) and no minimum, and derived the collapse
 * breakpoint from the ACTIVE PAGE's natural width — recomputed every 200 ms. Both
 * halves of that were wrong, measured live 2026-08-11 (`nidara-ipc queryUI`,
 * 18 pages × window widths):
 *
 *   - The breakpoint differed PER PAGE. At a 850px window, 16 pages kept the
 *     sidebar docked while Appearance and Region (the two with a 320px preview)
 *     collapsed it — so merely navigating Display → Appearance made the sidebar
 *     vanish and the page jump 518 → 720px wide.
 *   - Content width was not monotonic in window width: 900 → 568, 800 → 468,
 *     700 → **618**, 600 → 518. Narrowing the window made the page WIDER at the
 *     breakpoint, because collapsing hands the sidebar's 250px to the content.
 *   - With no minimum, the window shrank to 250px while the page stayed at 403px
 *     and was CLIPPED — no scroll, no floor. On the way there a subtitle got 47px
 *     of column, i.e. one word per line.
 *
 * 800 is not a round number picked for looks: it is what the widest ROW needs.
 * Measured across all 18 pages, the widest trailing control is 388px (Appearance →
 * Accent color), then 324 (Region) and 315 (a slider row). At C = 800 the page
 * inside its `$space-10` padding is 720 and a row's content box is 688, which
 * leaves the widest row ~347px of text column — about 40 characters, enough for
 * every title in the shipped locales on one line. Below ~720 that budget starts
 * breaking titles: measured, Appearance breaks at 518 and most pages by 418.
 *
 * That is also the argument against an elastic band: between 640 and 800 there is
 * nothing to gain and a text column to lose. A constant instead buys the thing a
 * settings window actually needs — ONE width for the row contract to be correct
 * at, forever, instead of a range where "correct" has to hold at every point.
 * (Prior art for the shape: macOS System Settings has a hard minimum window and
 * never reflows its content pane.)
 *
 * ## `contentFloor` — the distress width, and why the law needs a second number
 *
 * The first version of this made `content` the window's minimum too, so the pane
 * could never be squeezed at all. On a TILING compositor that is not a promise
 * anyone keeps: `set_size_request` reaches Hyprland as `xdg_toplevel.set_min_size`
 * and Hyprland tiles at whatever the layout says regardless. Measured 2026-08-11
 * with Settings in a 673px tile and the floor at 802: GTK laid the window out at
 * its own 802px minimum, the compositor cut the last 129px off, and a row's
 * trailing button went with it. Unreachable controls are worse than tight text.
 *
 * ⚠️ And it cannot be made conditional on being tiled — that was the second try.
 * **Hyprland never clears the `tiled` toplevel state**: measured on a window it had
 * just floated and resized, GTK still carried `tiled-top/left/right/bottom` AND
 * `maximized`. As a signal for "someone else is sizing me" it is stuck on.
 *
 * So the floor is uniform and it is `contentFloor`: the pane is `content` in every
 * window with room for it — which is every ordinary one, including the size it
 * opens at and every width where the sidebar docks — and yields below that.
 *
 * This is NOT the elastic band that was rejected. That question was which width
 * pages are DESIGNED at, and the answer is one constant. This is what happens in a
 * window too small for the design, where the only choice is which way to fail. 560
 * covers the tiles that actually happen (four columns on a 2560 screen is 640,
 * three is 853); under it the page scrolls horizontally instead.
 */
/**
 * Row heights, as NUMBERS. `.nidara-row--single` / `--double` in
 * `ui/lib/styles/_components.scss` are where they are PAINTED; these are for the
 * code that has to reason about them — a list that wants to show six whole rows
 * cannot ask CSS how tall a row is.
 *
 * ⚠️ MIRRORED. `scripts/ci/row-height-check.mjs` reads both files and fails if
 * they drift, for the same reason `blur-threshold-check` exists: two numbers that
 * must agree, in two languages, neither of which can read the other.
 */
export const ROW_HEIGHT = {
    /** `.nidara-row--single` — a title, or a title and a control. */
    single: 48,
    /** `.nidara-row--double` — a title with a subtitle under it. */
    double: 72,
} as const

/**
 * WIZARD_LAYOUT — the installer's height law, the sibling of WINDOW_LAYOUT's
 * width law.
 *
 * ## Why there has to be one
 *
 * The width of a NidaraWindow is derived: 250 sidebar + 600 pane + 2 rim, every
 * number argued. The HEIGHT was the literal 760 that `NidaraWindow` defaults to
 * for two-pane windows — and because the window was 760, the country list was
 * given `height: 300` and the language list `height: 320`, hand-picked so that
 * the page fitted inside it. That is backwards, and it costs three things:
 * dragging the window taller leaves dead space (the list still measures 300),
 * 300 ÷ 72 is 4.2 so a row is always cut in half at the bottom, and on the region
 * page the card the country fills in starts after a 300px block whatever the
 * window's size, which reads as belonging to another question.
 *
 * ## The law
 *
 * **The list states a budget in ROWS; everything else is measured.** The window
 * opens at its natural height, which is the page's own — heading, prose, search
 * box, `listRows` whole rows, whatever the page puts under them, chrome — added
 * up by GTK rather than by us. There is exactly one invented number here and it
 * is `listRows`; the rest cannot be written down honestly, because how tall a
 * paragraph is depends on the language it is written in.
 *
 * Above the natural height the list TAKES the extra (it is the only vexpanding
 * thing on the page). Below it, the list gives back down to `minListRows` and
 * then the page scrolls.
 *
 * Measured on 2026-09-03 with the Spanish welcome page: 852 × 889 at
 * `listRows: 6`, against the 760 it used to open at with 4.2 rows visible.
 */
export const WIZARD_LAYOUT = {
    /** Whole rows the list opens with — the page's natural height follows from it. */
    listRows: 6,
    /** Whole rows it may be squeezed to before the page starts scrolling. */
    minListRows: 3,
    /**
     * Safety cap on the opening height, as a fraction of the monitor's height.
     * Not layout — a guard: Hyprland CENTRES a window taller than the screen
     * rather than clipping it, so the header would sit above the top edge with no
     * way to reach it. GTK4 removed `gdk_monitor_get_workarea`, so this is the
     * whole monitor and the fraction is what stands in for the bar and the gaps.
     */
    maxMonitorFraction: 0.9,
} as const

export const WINDOW_LAYOUT = {
    /** Docked sidebar column, including its 8px capsule margin. */
    sidebar: 250,
    /** The content pane for standard system applications (Settings). A CONSTANT — see above. */
    content: 800,
    /**
     * The content pane for step-by-step wizards and installers.
     *
     * ## It is derived now, and it was not
     *
     * This was 600 with a comment reading "focused single-column content pane for
     * step-by-step wizards" and nothing else — the one number in this file that
     * was chosen rather than argued. It held while every wizard page WAS a single
     * column of cards. Manual partitioning (#399) is the first page that is not,
     * and a table cannot be squeezed the way a column of cards can: its columns
     * are as wide as their widest cell, and below that they compress one by one
     * until a dropdown is a control nobody can read.
     *
     * So it is measured, the same way `content`'s 800 was. The instrument is
     * `scripts/dev/disk-page-probe.ts`, which mounts the page alone and reports
     * what the table asks for; run 2026-09-03 over all twelve shipped locales:
     *
     *     ru 693 · pt 640 · es 629 · ja 627 · fr 618 · it 607 · nl 603
     *     pl 591 · de 583 · en 543 · zh 519
     *
     * Russian is the widest and it is the column HEADINGS that make it so
     * ("Точка монтирования" 131px, "Форматировать" 100px), not the data. Add the
     * page's own horizontal padding (`.installer-body`, 48px measured, not copied
     * from the stylesheet) and ~20px for a device path longer than this machine's
     * (`/dev/nvme0n1p10` against the `/dev/nvme0n1p1` the probe saw) and the pane
     * is 761. This is the rung under it.
     *
     * ⚠️ Measure the WORST CASE, not the opening state. A `Gtk.DropDown` is as
     * wide as its SELECTED item: with the mount labels this table first shipped
     * with, the same table measured 543 unanswered and 645 once somebody chose
     * "EFI System (/boot/efi)" — a page that grows past its pane the moment it is
     * used. The labels are the bare mount paths now (see `MOUNT_OPTIONS` in
     * `steps/disk.ts`) and the column is a constant.
     */
    wizardContent: 760,
    /** The distress width — only a compositor can push the pane here. */
    contentFloor: 560,
    /**
     * The 1px glass rim on each side of the window (`.nidara-window-glass`), which
     * the minimum size has to include or the pane loses 2px at the floor.
     */
    glassRim: 1,
    /** Window minimum height. Two cards and a header have to fit, or the scroll
     *  view is taller than its own first row. */
    minHeight: 480,
    /**
     * How much wider than the breakpoint a window OPENS — half of it on each side
     * of the content pane.
     *
     * ⚠️ Not decoration, and not optional. At exactly `S + C` the law says the pane
     * is "centred in W − S", and centring something in its own width puts it flush
     * against the sidebar on one side and against the glass rim on the other: the
     * page has no air at all. This is the air. It is stated here because it is a
     * number a caller can otherwise re-derive and get wrong — which is exactly what
     * happened to the installer on 2026-09-03, opening 852 instead of 898 and
     * looking cramped the moment it was on screen.
     */
    openGutter: 48,
} as const

/** Window width at or above which the sidebar is DOCKED rather than floating. */
export const collapseAtFor = (
    sidebar: number = WINDOW_LAYOUT.sidebar,
    content: number = WINDOW_LAYOUT.content,
): number => sidebar + content

/** Smallest window width the content pane can be shown at without scrolling. */
export const minWindowWidthFor = (content: number = WINDOW_LAYOUT.content): number =>
    content + WINDOW_LAYOUT.glassRim * 2


