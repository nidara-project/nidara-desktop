-- hypr-game-mode-test.lua — event-handler harness for config/hypr/hyprland.lua
--
-- The game-mode entry/exit handlers only run when Steam opens a window, which is
-- not something a test can arrange. So instead of faking a game, this fakes
-- HYPRLAND: a stub `hl` table records what the config asks the compositor to do,
-- the real config file is loaded against it, and the registered `window.open` /
-- `window.destroy` callbacks are invoked directly with a game-shaped payload.
--
-- What it asserts is the one thing that used to be wrong: the power profile in
-- effect after a game session is the one that was in effect before it.
--
--   lua scripts/dev/hypr-game-mode-test.lua        # exits 1 on failure
--
-- Run it from the repo root. It never touches the live session: `powerprofilesctl`
-- is intercepted, both when the config SETS a profile (hl.exec_cmd) and when it
-- READS one (io.popen).

local repoRoot = arg[0]:match("^(.*)/scripts/dev/[^/]+$") or "."
-- NIDARA_HYPR_CONFIG points the harness at another copy of the config — that is
-- how it gets run against the PREVIOUS version to confirm it can still fail:
--   git show main:config/hypr/hyprland.lua > /tmp/old.lua
--   NIDARA_HYPR_CONFIG=/tmp/old.lua lua scripts/dev/hypr-game-mode-test.lua
local CONFIG = os.getenv("NIDARA_HYPR_CONFIG") or (repoRoot .. "/config/hypr/hyprland.lua")

-- ── The fake world ───────────────────────────────────────────────────────────
local world = {
    profile = "balanced",   -- what `powerprofilesctl get` will report
    ran = {},               -- every shell command the config asked to run
}

io.popen = function(cmd)
    if cmd:match("powerprofilesctl%s+get") then
        local p = world.profile
        return { read = function() return p end, close = function() end }
    end
    -- Anything else (Steam art lookup) finds nothing, which is a valid outcome.
    return { read = function() return nil end, close = function() end }
end

local realExecute = os.execute
os.execute = function(cmd) table.insert(world.ran, cmd); return true end

local function runCommand(cmd)
    table.insert(world.ran, cmd)
    local prof = cmd:match("powerprofilesctl%s+set%s+(%S+)")
    if prof then world.profile = prof end
end

-- Timers fire immediately: the exit path defers its work by 3 s to see whether
-- another game window is still around, and the harness has nothing to wait for.
local pendingTimers = {}

local handlers = {}
-- Set while the fake user is standing on a workspace other than gamespace.
local elsewhere = false
local hl
hl = {
    on          = function(event, fn) handlers[event] = fn end,
    exec_cmd    = runCommand,
    dispatch    = function() end,
    timer       = function(fn) table.insert(pendingTimers, fn) end,
    get_active_workspace = function()
        if elsewhere then return { id = 1, name = "1", monitor = "DP-1" } end
        return { id = 9, name = "gamespace", monitor = "DP-1" }
    end,
    notify      = function() end,
    bind = function() end, config = function() end, monitor = function() end,
    animation = function() end, curve = function() end, window_rule = function() end,
    workspace_rule = function() end, layer_rule = function() end, define_submap = function() end,
    notification = { create = function() end },
    dsp = setmetatable({}, {
        -- Every dispatcher is a no-op that returns a marker; the config only ever
        -- passes the result straight to hl.dispatch.
        __index = function(t, k)
            local v = setmetatable({}, { __index = function() return function() return {} end end })
            rawset(t, k, v)
            return v
        end,
    }),
}
hl.dsp.exec_cmd = function() return {} end
hl.dsp.focus    = function() return {} end
_G.hl = hl

-- ── Load the real config ─────────────────────────────────────────────────────
local chunk, err = loadfile(CONFIG)
if not chunk then io.stderr:write("cannot load config: " .. tostring(err) .. "\n"); os.exit(1) end
local ok, loadErr = pcall(chunk)
if not ok then io.stderr:write("config raised: " .. tostring(loadErr) .. "\n"); os.exit(1) end

if not handlers["window.open"] or not handlers["window.destroy"] then
    io.stderr:write("config registered no game-mode handlers — did the events get renamed?\n")
    os.exit(1)
end

-- ── Driving a session ────────────────────────────────────────────────────────
local GAME = { address = "0xdead", class = "steam_app_440", pid = 0 }

local function flushTimers()
    local due = pendingTimers
    pendingTimers = {}
    for _, fn in ipairs(due) do fn() end
end

local function playAndQuit(window)
    handlers["window.open"](window or GAME)
    handlers["window.destroy"](window or GAME)
    flushTimers()
end

-- ── Assertions ───────────────────────────────────────────────────────────────
local failures = 0
local function check(name, got, want)
    if got == want then
        print(string.format("  ok    %-46s %s", name, tostring(got)))
    else
        failures = failures + 1
        print(string.format("  FAIL  %-46s got %s, want %s", name, tostring(got), tostring(want)))
    end
end

-- The config reads ~/.config/nidara/gaming.json for `performanceProfile`. Point
-- HOME at a fixture so the test states its own preconditions instead of
-- inheriting the developer's.
local fixtureHome = os.getenv("TMPDIR") or "/tmp"
fixtureHome = fixtureHome .. "/nidara-gamemode-test"
os.execute = realExecute
os.execute("mkdir -p " .. fixtureHome .. "/.config/nidara")
local function writeGamingCfg(perfOn)
    local f = assert(io.open(fixtureHome .. "/.config/nidara/gaming.json", "w"))
    f:write(string.format('{ "wallpaperMode": "none", "performanceProfile": %s }', tostring(perfOn)))
    f:close()
end
os.execute = function(cmd) table.insert(world.ran, cmd); return true end

local realGetenv = os.getenv
os.getenv = function(k) if k == "HOME" then return fixtureHome end return realGetenv(k) end

print("game mode → power profile")

-- The exit path's focus return needs a workspace to go back to; a real session
-- sets this the first time any non-gamespace workspace becomes active.
handlers["workspace.active"]({ id = 1, name = "1" })

writeGamingCfg(true)
world.profile = "power-saver"
playAndQuit()
check("power-saver survives a game session", world.profile, "power-saver")

world.profile = "performance"
playAndQuit()
check("performance survives a game session", world.profile, "performance")

world.profile = "balanced"
playAndQuit()
check("balanced survives a game session", world.profile, "balanced")

-- Two windows for one game (a launcher plus the game itself) must not make the
-- second one capture the profile the first one already changed.
world.profile = "power-saver"
handlers["window.open"](GAME)
handlers["window.open"]({ address = "0xbeef", class = "steam_app_440", pid = 0 })
check("mid-session profile is performance", world.profile, "performance")
handlers["window.destroy"]({ address = "0xbeef", class = "steam_app_440", pid = 0 })
handlers["window.destroy"](GAME)
flushTimers()
check("two windows, one game: still restored", world.profile, "power-saver")

-- A profile the user picked DURING the game is a newer decision than ours.
world.profile = "balanced"
handlers["window.open"](GAME)
world.profile = "power-saver"           -- user changes it in Settings mid-game
handlers["window.destroy"](GAME)
flushTimers()
check("a mid-game choice is not undone", world.profile, "power-saver")

-- Quitting a game after wandering off gamespace must still undo the session.
-- Undoing it and putting the user back used to share one condition, so this case
-- left the machine on performance until the next game happened to end on gamespace.
writeGamingCfg(true)
world.profile = "balanced"
handlers["window.open"](GAME)
elsewhere = true                        -- the user has moved to a normal workspace
handlers["window.destroy"](GAME)
flushTimers()
elsewhere = false
check("quit from another workspace still restores", world.profile, "balanced")

-- With the toggle off the config must not touch the profile at all.
writeGamingCfg(false)
world.profile = "power-saver"
world.ran = {}
playAndQuit()
check("toggle off: profile untouched", world.profile, "power-saver")
-- Stronger than the value: with the toggle off the config must not RUN
-- powerprofilesctl at all, in either direction.
local touched = 0
for _, cmd in ipairs(world.ran) do
    if cmd:match("powerprofilesctl") then touched = touched + 1 end
end
check("toggle off: powerprofilesctl never run", touched, 0)

print(failures == 0 and "\nall good" or string.format("\n%d failing", failures))
os.exit(failures == 0 and 0 or 1)
