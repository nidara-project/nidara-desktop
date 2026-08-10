import { Gtk } from "ags/gtk4"
import GLib from "gi://GLib"
import { makeAvatar } from "./avatar"
import { withGlassCapsule } from "./glass-capsule"
import { playEntrance } from "./entrance"

// The identity-and-password column both login screens are built around: avatar,
// name, password field, primary button, failure message. The greeter adds a
// session selector and a user switcher on top; the lockscreen adds nothing.
//
// ── WHAT IS *NOT* SHARED, AND WHY THE SPLIT IS HERE ─────────────────────────
// The AUTHENTICATION itself. The greeter talks to greetd and starts a session;
// the lockscreen talks to PAM and lifts a session lock. Those are different
// protocols with different failure shapes, and pretending otherwise would mean a
// parameter that is really two functions in a trench coat. So this component owns
// the CHROME and the FEEDBACK, and the caller owns the attempt: it gets
// `onSubmit`, and `setLoading` / `showError` to drive back.
//
// Same injection rule as ui/lib/power-bar.ts: `t()` comes from the bundle,
// because the two catalogs are deliberately different.

export type AuthCardKey = "password"

export interface AuthCardUser {
    displayName: string
    avatarPath: string | null
}

export interface AuthCardOpts {
    user: AuthCardUser
    /** The bundle's own `t()`. Used here only for the field's placeholder. */
    t: (key: AuthCardKey) => string
    /** The primary control. A spinner is only built when `spinner` is set. */
    primary: { label: string; spinner: boolean }
    /**
     * Top margins for username / entry / primary button. Genuinely per-surface:
     * the greeter's card carries a dropdown and a switcher underneath, so it
     * breathes wider than the lockscreen's five-element column. Numbers stay with
     * the bundle that chose them rather than being averaged into one here.
     */
    margins: { username: number; entry: number; button: number }
    onSubmit: () => void
}

export interface AuthCard {
    /** The column. Append extra controls BEFORE the error capsule with `insert`. */
    widget: Gtk.Box
    passwordEntry: Gtk.PasswordEntry
    primaryButton: Gtk.Button
    /** Set the primary label (loading text lives with the caller's catalog). */
    setPrimaryLabel: (text: string) => void
    setLoading: (loading: boolean) => void
    /** Show a failure message. Shakes the field and starts the expiry clock. */
    showError: (msg: string) => void
    /** Hide it now — used when the caller switches user or starts a new attempt. */
    clearError: () => void
    /**
     * Empty the password field WITHOUT the clear-on-typing handler firing. Every
     * caller wants this after a failed attempt; using `passwordEntry.set_text("")`
     * directly wipes the error message that was just shown.
     */
    resetPassword: () => void
    /** Add a control between the primary button and the error capsule. */
    insertBeforeError: (w: Gtk.Widget) => void
    /** Add a control BELOW the error capsule (the greeter's user switcher). */
    append: (w: Gtk.Widget) => void
    /** Swap the displayed identity (the greeter's user switcher). */
    setUser: (u: AuthCardUser) => void
}

/**
 * How long a failure message survives on its own.
 *
 * 🔑 It used to survive FOREVER. Nothing on either surface watched the keyboard —
 * no `changed`, no `notify::text` — and the only thing that ever hid the message
 * was starting another attempt. So you typed your password again with "Wrong
 * password" still sitting under the field, contradicting what you were doing.
 *
 * Two triggers, because they answer different questions and only one of them is
 * about typing:
 *   • TYPING clears it immediately — "I know, I am already fixing it." This is
 *     the one that matters, and it is what GNOME's lock screen does.
 *   • The TIMER covers the other case, a wrong password left untouched on a
 *     screen nobody is at. macOS/iOS keep the message indefinitely there, which is
 *     defensible, but their message is also the only thing on the screen; ours
 *     sits under a live clock and a card that has already shaken.
 *
 * 8s: long enough to read a wrapped two-line message without hurrying, short
 * enough that a glance at the screen a minute later is not still being told off.
 */
const ERROR_TTL_MS = 8000

export function buildAuthCard(opts: AuthCardOpts): AuthCard {
    const avatar = makeAvatar(80)
    avatar.setSource(opts.user.avatarPath)

    const usernameLabel = new Gtk.Label({
        label: opts.user.displayName,
        css_classes: ["greeter-username"],
        halign: Gtk.Align.CENTER,
        margin_top: opts.margins.username,
    })

    const passwordEntry = new Gtk.PasswordEntry({
        placeholder_text: opts.t("password"),
        show_peek_icon: true,
        css_classes: ["greeter-password"],
        halign: Gtk.Align.CENTER,
        width_request: 280,
        margin_top: opts.margins.entry,
    })

    // NO caps-lock warning of our own, deliberately. `Gtk.PasswordEntry` already
    // builds one — an `image.caps-lock-indicator` inside the field — so the greeter
    // used to show TWO warnings for one state while the lockscreen, which never had
    // ours, showed one. The field's is the one that survives: it is where the cursor
    // is, it is what macOS and iOS do, and it makes the two screens identical for
    // free. Styled in ui/greeter/style.scss; there is no property to turn it off, so
    // adding a second one is the only mistake available here.
    //
    // ⚠️ Removing the greeter's copy (#100) is also what left a call to its deleted
    // `syncCaps()` in the card's `map` handler, which made the whole card invisible
    // for a day (#116). The handler below is the same one; keep it boring.

    const primaryLabel = new Gtk.Label({ label: opts.primary.label })
    let primarySpinner: Gtk.Spinner | null = null
    let primaryChild: Gtk.Widget = primaryLabel
    if (opts.primary.spinner) {
        primarySpinner = new Gtk.Spinner({ visible: false })
        const inner = new Gtk.Box({ spacing: 8, halign: Gtk.Align.CENTER })
        inner.append(primarySpinner)
        inner.append(primaryLabel)
        primaryChild = inner
    }
    const primaryButton = new Gtk.Button({
        css_classes: ["greeter-login-btn"],
        halign: Gtk.Align.CENTER,
        width_request: 280,
        margin_top: opts.margins.button,
        child: primaryChild,
    })

    const errorLabel = new Gtk.Label({
        label: "",
        css_classes: ["greeter-error"],
        wrap: true,
        halign: Gtk.Align.CENTER,
    })
    // On glass: it sits in the middle of the card, where the scrim is weakest, and
    // neutral text on a light wallpaper needs a body behind it.
    const errorWrap = withGlassCapsule(errorLabel)
    errorWrap.halign = Gtk.Align.CENTER

    // 🔑 THE MESSAGE LIVES IN A RESERVED SLOT, and it is hidden with OPACITY rather
    // than `visible`, because `visible = false` gives a widget no allocation.
    //
    // The card is `valign: CENTER`, so anything that changes its height moves its
    // whole contents. Measured 2026-08-10: showing the message added 30px (24 of
    // capsule + 6 of margin) and lifted the avatar, the name, the field and the
    // button by exactly 15px each — half of it, because centring splits the growth
    // in two. Failing a password made the thing you were typing into jump.
    //
    // 🔑 What reserves the space is the OPACITY, not any height: an empty
    // Gtk.Label still measures one line, so this capsule is 24px tall whether it
    // holds a message or nothing. A `min-height` on the slot looked like the
    // mechanism and was not — removed after a mutation test showed setting it to 0
    // changed nothing. One line is the true worst case: all 36 real messages
    // (12 locales × wrongPassword/noSession/loginError) measure 24px, none wraps,
    // widest 216px against the card's 280.
    //
    // The cost, stated plainly: the strip is always reserved, so with no error on
    // screen the card sits 15px higher than it used to. That is the same 15px —
    // paid once, statically, instead of every time authentication fails.
    const errorSlot = new Gtk.Box({
        css_classes: ["greeter-error-slot"],
        halign: Gtk.Align.CENTER,
        margin_top: 6,
    })
    errorSlot.append(errorWrap)
    errorWrap.opacity = 0

    // ── Failure feedback ──────────────────────────────────────────────────────
    let errorTimer = 0
    const stopTimer = () => {
        if (errorTimer) { GLib.source_remove(errorTimer); errorTimer = 0 }
    }
    const clearError = () => {
        stopTimer()
        errorWrap.opacity = 0
    }
    const showError = (msg: string) => {
        // ⚠️ Cancel the PREVIOUS timer first. Without this, a second failure inside
        // the window inherits the first one's countdown and its message vanishes
        // early — the classic way this pattern breaks.
        stopTimer()
        errorLabel.label = msg
        errorWrap.opacity = 1
        passwordEntry.add_css_class("greeter-shake")
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            passwordEntry.remove_css_class("greeter-shake")
            return GLib.SOURCE_REMOVE
        })
        errorTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ERROR_TTL_MS, () => {
            errorWrap.opacity = 0
            errorTimer = 0
            return GLib.SOURCE_REMOVE
        })
    }

    // Typing means "I am already fixing it".
    //
    // ⚠️ `notify::text` fires for PROGRAMMATIC writes as well, and a failed attempt
    // ends by emptying the field — so the naive version of this handler cleared the
    // message roughly a millisecond after showing it, and the user saw a flicker
    // instead of a reason. Hence `resetPassword()` below and this guard: the card
    // owns the one write that is not typing, so no caller has to remember an
    // ordering rule to keep its own error message on screen.
    let clearingProgrammatically = false
    const resetPassword = () => {
        clearingProgrammatically = true
        passwordEntry.set_text("")
        clearingProgrammatically = false
    }
    passwordEntry.connect("notify::text", () => {
        if (clearingProgrammatically) return
        if (errorWrap.opacity > 0) clearError()
    })

    passwordEntry.connect("activate", opts.onSubmit)
    primaryButton.connect("clicked", opts.onSubmit)

    const col = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        // Entrance fade — the class pair is defined in ui/greeter/style.scss.
        css_classes: ["greeter-card"],
    })

    col.append(avatar.widget)
    col.append(usernameLabel)
    // Painted capsules (ui/lib/glass-capsule.ts). followFocus only on the ENTRY: an
    // input shows focus as its edge going accent, a button shows a ring, and no
    // control shows both. Rim weights: the subtle one on the field, the stronger one
    // marking the primary button.
    col.append(withGlassCapsule(passwordEntry, "subtle", true))
    col.append(withGlassCapsule(primaryButton, "strong", false))
    col.append(errorSlot)

    // Entrance: driven by the frame clock, not a CSS transition — see
    // ui/lib/entrance.ts for the measurement that forced that. 40 rather than 21
    // because this column is `valign: CENTER` and centring hands half the margin
    // back; both blocks end up travelling the same ~21px.
    playEntrance(col, { rise: 40 })

    col.connect("map", () => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            passwordEntry.grab_focus()
            return GLib.SOURCE_REMOVE
        })
    })

    return {
        widget: col,
        passwordEntry,
        primaryButton,
        setPrimaryLabel: (text: string) => { primaryLabel.label = text },
        setLoading: (loading: boolean) => {
            primaryButton.sensitive = !loading
            passwordEntry.sensitive = !loading
            if (primarySpinner) {
                primarySpinner.visible = loading
                if (loading) primarySpinner.start(); else primarySpinner.stop()
            }
        },
        showError,
        clearError,
        resetPassword,
        // Between the primary button and the error capsule: the greeter's session
        // selector. The message stays below the controls so appearing never shoves
        // them around.
        insertBeforeError: (w: Gtk.Widget) => col.insert_child_after(w, primaryButton.get_parent()),
        // Below the error capsule: the greeter's user switcher, which is the one
        // thing that really does sit at the bottom of that card.
        append: (w: Gtk.Widget) => col.append(w),
        setUser: (u: AuthCardUser) => {
            avatar.setSource(u.avatarPath)
            usernameLabel.label = u.displayName
        },
    }
}
