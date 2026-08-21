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
        blur = {
            enabled          = true,
            size             = 6,
            passes           = 3,
            noise            = 0.01,
            contrast         = 1.1,
            brightness       = 0.8,
            vibrancy         = 0.3,
            vibrancy_darkness = 0.1,
            xray             = false,
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
hl.layer_rule({ match = { namespace = "nidara-greeter" }, blur = true, ignore_alpha = 0.3 })
