-- Hyprland Lua configuration for the Nidara greeter (greetd session)
-- Installed to /etc/greetd/hyprland-greeter.lua
-- This is a minimal, locked-down config — not user-editable.

-- ── Monitor ───────────────────────────────────────────────────────────────────
hl.monitor({ output = "", mode = "preferred", position = "auto", scale = 1 })

-- ── Environment ───────────────────────────────────────────────────────────────
hl.env("HOME",           "/var/lib/greeter")
hl.env("XDG_CONFIG_HOME","/var/lib/greeter/.config")

-- ── Startup ───────────────────────────────────────────────────────────────────
hl.on("hyprland.start", function()
    hl.exec_cmd("awww-daemon")
    hl.exec_cmd("sleep 1 && if [ -f /usr/share/nidara/wallpaper-greeter.jpg ]; then awww img /usr/share/nidara/wallpaper-greeter.jpg --transition-type fade --transition-duration 1; else awww img /usr/share/nidara/wallpaper.jpg --transition-type fade --transition-duration 1; fi")
    -- Launch greeter; exit Hyprland when it closes
    -- (Lua parser: the legacy `hyprctl dispatch exit` errors out and the
    -- greeter compositor would never exit)
    hl.exec_cmd("nidara-greeter; hyprctl dispatch 'hl.dsp.exit()'")
end)

-- ── Keyboard layout: read saved greeter pref, fall back to "us" ──────────────
local function readKbLayout()
    local f = io.open("/var/lib/greeter/.config/nidara/greeter-prefs.json", "r")
    if not f then return "us" end
    local content = f:read("*a")
    f:close()
    local layout = content:match('"kbLayout"%s*:%s*"([^"]+)"')
    return layout and #layout > 0 and layout or "us"
end

-- ── Look & feel ───────────────────────────────────────────────────────────────
hl.config({
    -- Hyprland paints an "updated to X" news panel on its first launch after a
    -- version change. On the desktop that is merely off-brand; HERE it lands on
    -- top of the login card, so the first boot after any `pacman -Syu` that
    -- carries Hyprland greets the user with someone else's release notes over
    -- the password field. The desktop config disables it; this one has to say so
    -- too — the greeter is a separate compositor instance with its own config.
    -- (Caught by the clean-install VM sweep for 0.5.0, on a box that upgraded
    -- Hyprland to 0.56.0 during install.)
    ecosystem = {
        no_update_news = true,
    },

    input = {
        kb_layout    = readKbLayout(),
        follow_mouse = 1,
    },

    general = {
        border_size = 0,
        col = {
            active_border   = "rgba(ffffff00)",
            inactive_border = "rgba(ffffff00)",
        },
        layout = "dwindle",
    },

    decoration = {
        rounding = 0,
        -- ⚠️ THESE ARE THE SHELL'S NUMBERS, VERBATIM (config/hypr/hyprland.lua).
        -- Not similar to them — the same, and that is the point. This block used to
        -- diverge in five of nine values (size 6/passes 3, contrast 1.1, vibrancy 0.3,
        -- and `brightness 0.8`) and nobody had decided any of it; they were simply two
        -- tables written months apart. The cost showed up on 2026-08-23, when #235
        -- raised `brightness` to 1.0 because 0.8 was drawing a hard dark line along the
        -- curved edge of every capsule — and it fixed the SHELL only, because the
        -- greeter keeps its own compositor config. Same failure as the glass painters
        -- stopping at the `ui/lib` boundary (#253), one directory over.
        --
        -- The full reasoning for `brightness = 1.0` lives beside the shell's copy; do
        -- not restate it here, read it there. What matters on this side: the login
        -- screen and the desktop are the same material, so they get the same optics.
        blur = {
            enabled            = true,
            size               = 2,
            passes             = 2,
            popups             = true,
            popups_ignorealpha = 0.30,
            ignore_opacity     = true,
            new_optimizations  = true,
            xray               = false,
            noise              = 0.01,
            contrast           = 1.2,
            brightness         = 1.0,
            vibrancy           = 0.4,
            vibrancy_darkness  = 0.1,
        },
        shadow = {
            enabled = false,
        },
    },

    animations = {
        enabled = false,
    },

    misc = {
        disable_hyprland_logo   = true,
        force_default_wallpaper = 0,
    },
})

-- ── Layer rules ───────────────────────────────────────────────────────────────
-- ⚠️ `ignore_alpha` and `blur_popups` match the shell's surfaces exactly (0.23,
-- popups on). 0.3 was the old pair to a 0.55 glass; with the glass now at the shell's
-- floor (LOCK_GLASS.fill.a = 0.24) a 0.3 threshold would sit ABOVE it and this layer
-- would stop being blurred at all — silently, since the config still parses and the
-- greeter still boots. `scripts/ci/blur-threshold-check.mjs` is what stands between us
-- and that; it reads BOTH numbers, so move them together or it fails.
--
-- `blur_popups` is not optional at this glass: the dropdown popovers are drawn in CSS
-- with `--nidara-glass`, and at 0.24 alpha an unblurred popup over a busy wallpaper is
-- not legible. The shell has had it on all four of its layers for the same reason.
hl.layer_rule({ match = { namespace = "nidara-greeter" }, blur = true, blur_popups = true, ignore_alpha = 0.23 })
