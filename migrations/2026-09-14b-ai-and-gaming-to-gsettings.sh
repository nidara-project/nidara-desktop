# 2026-09-14 — ai.json and gaming.json → GSettings `org.nidara.ai` / `org.nidara.gaming` (#573)
#
# The second pair of stores to move, later than the first six because other
# programs read these files directly: bin/nidara-agent, bin/nidara-mcp and the
# four computer-use helpers read ai.json's gates, and config/hypr/hyprland.lua read
# gaming.json with pattern matches. They read GSettings (and, for the compositor,
# the NIDARA_GAMING table the shell writes) in the same change that ships this.
#
# A separate unit, not two more lines in 2026-09-14-settings-to-gsettings: that one
# has already run on machines that will never run it again.

settings_import ai.json     ai     || return 1
settings_import gaming.json gaming || return 1
