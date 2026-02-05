# MiDistroIA Dock Specification: Gaussian V100 (Seamless Overlap) 🧸🍎💎

This document defines the technical implementation, physics, and geometry of the Unified Dock Engine as of version 100 (Overlap Model).

## 1. Core Architecture: Unified Animation Engine
The dock uses a **Single Central Clock (60fps)** to synchronize all animations. Version 90 introduced the **Global Tiling Engine**, and Version 100 adds the **Seamless Overlap Model** to allow magnified icons to hover over windows.

## 2. Physics & Constants
The magnification follows a Gaussian (Sine-based) curve anchored to the **Hybrid Physics Engine**.

| Parameter | Value | Description |
| :--- | :--- | :--- |
| **Physical Base** | **64px** | Resting icon size for maximum stability. |
| **Max Scale** | **2.0x** | Target magnification (128px / 64px = 2.0). |
| **lerp Factor** | **0.12** | Smoothing factor for fluid transitions. |
| **Base Slot** | **80px** | Fixed base width (64px + 4px * 2 margins + internal gaps). |

## 3. Geometric Stability (Zero-Vibration Logic)
To achieve zero-vibration and eliminate the "jitter" during magnification, the dock implements three critical rules:

1. **Global Tiling Engine**: Each item's `start` and `end` coordinates are calculated as absolute floating-point values from the dock center. These are snapped to the pixel grid (`Math.round`) before widget sizes are applied.
2. **Manual Centering (Anti-Parity Jitter)**: We bypass `halign: CENTER` on the container (`#the-dock-bar`). Instead, `halign: START` is enforced, and the container's `margin_start` is calculated manually every frame: `Math.round((monitorWidth - totalIntWidth) / 2)`. This prevents the "jumping" caused by standard alignment engines when container width changes by odd pixel values.
3. **START Alignment on Items**: All `itemBox` widgets use `halign: START` and manual `margin_start` calculation to ensure icons don't shift relative to their "slot" during scale changes.

## 4. Seamless Overlap Model (V100)
To prevent magnified icons from being cut off by the dock's window or other applications, we use an overlap model:
- **Window Layer**: The Dock operates on the `TOP` layer (changed from `OVERLAY` in V105). This allows fullscreen windows (like YouTube or Games) to cover the dock, while maintaining its presence above regular tiled/floating windows.
- **Window Geometry**: The Gtk4LayerShell window is **200px** high, but the **Exclusive Zone** is locked to **104px**.
- **Window Transparency**: The top ~96px of the window are transparent and non-interactive (`exclusive_zone: 0` for that area), allowing magnified icons to render *over* other applications.
- **Vertical Distribution**: 
  - **Top Gap**: 2px
  - **Pill Height**: 92px
  - **Bottom Gap**: 10px (Total perceived dock height: 104px).

## 5. Background Pill (The Glass)
- **Gaussian Symmetric Alignment**: Icons are centered in the 92px pill using a **14px** bottom margin for the icon and a **4px** bottom margin for the indicator dot.
- **Lockstep Sync**: The background width is calculated as the sum of the integer-snapped icon slots, moving in perfect synchrony with the icons.

## 6. Interaction Model
- **Input Region**: The interactive area is precision-locked to the 92px pill (y=98 to y=190 in the 200px window).
- **Motion Trigger**: Magnification is only triggered if the cursor is within the pill's vertically active zone, preventing "ghost" hovers.
41: 
42: ## 7. Icon Policy & Resolution (V94.3)
43: To maintain DistroIA identity while respecting Third-Party branding, the dock implements a **Hybrid Policy**:
44: 
45: 1. **Linux System Core**: Absolute Material paths are enforced for core utilities:
46:    - `pavucontrol` (Volume), `rhythmbox` (Music), `clocks` (Reloj), `nautilus` (Files), `terminal`, `calculator`, `calendar`, `settings`.
47: 2. **Branded Apps & WebApps**: Embedded icons (`GIcon` / `res.path` from `.desktop`) are strictly prioritized over themed names. This ensures PWAs (YouTube, Gmail) and Pro Software (GIMP, Blender) maintain their original identity.
48: 3. **Fallbacks**: If no local or system icon is found, the **Material Fallback Pool** (`assets/icons/material`) is used as a last resort.
49: 4. **Case-Preserving Resolution**: App IDs (e.g., `org.gnome.Calculator`) are preserved in their original casing to guarantee compatibility with `gtk-launch`.
50: 5. **Ghost Resolution**: When the standard application service fails, `AppService` is used to resolve human-readable names for "ghost" icons that are pinned but not currently found in the main system registry.
