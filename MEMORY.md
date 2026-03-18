# Long-term Memory: DistroIA Evolution

## Design Systems
- **Fluid Crystal:** The official aesthetic name for the translucent, blurred glass look with superellipse (n=3.2) curvature.
- **Grid Strategy:** All UI elements follow a strict mathematical grid (UNIT=80, GAP=12) to ensure perfect alignment across different widgets.

## The Distroia Manifesto 
- **Unified Identity:** Distroia is not just a collection of apps; it's a unified organism. Every pixel, from the dock to the control center, must share the same visual DNA (Fluid Crystal).
- **The 90% Rule:** While 100% unification in Linux is hampered by fragmentation (GTK, Qt, Compositors), we aim for a "90% perceived unity" where the user feels a seamless, premium experience.
- **Craft over Compromise:** We don't settle for "it works." We settle for "it's beautiful." If a technical limit (like Hyprglass framebuffers) blocks the vision, we research, fork, and push the boundaries.

## Technical Pillars
- **Compositor Native:** Prefer compositor-level shaders (Hyprglass) for glass effects to ensure consistency across windows.
- **AGS Flex:** Use AGS v3 as the ultimate "blank canvas" for modular, widget-based UI.
- **Squircle Perfection:** Consistency in curvature (n=3.2) is non-negotiable for a premium feel.

## ⚠️ Safety & Stability Protocol
- **Plugin Handling:** NEVER modify, recompile, or update plugin files while they are loaded in the compositor. You MUST run `hyprctl plugin unload <path>` (or use `hyprpm`) to completely remove the plugin from memory BEFORE making any source or binary changes.
- **Conversation History:** Protect the session at all costs. Hyprland crashes are the primary cause of lost conversation context. Stability is the absolute priority over visual experiments.

## Project Notes
- Developed by Angel & Antigravity.
- Goal: Create a cohesive, premium desktop experience on Linux that rivals commercial OS beauty without sacrificing open-source flexibility.
