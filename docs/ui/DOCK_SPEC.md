# MiDistroIA Dock Specification: Gaussian V10 🧸💎

This document defines the technical implementation, physics, and geometry of the Unified Dock Engine as of version 10.

## 1. Core Architecture: Unified Animation Engine
The dock uses a **Single-Clock / Unified Tick** system to prevent visual jitter and phase-mismatch.

- **Refresh Rate**: synchronized to ~60fps (16ms GLib loop).
- **Update Method**: All widgets (icons, separators) and the background width update in a single atomic frame.
- **Physics Logic**: Lerp-based (Linear Interpolation) with a smoothing factor of **0.15** per frame.

## 2. Magnification Physics (Gaussian Curve)
The magnification follows a standard 2D Gaussian distribution for organic, smooth scaling.

| Parameter | Value | Description |
| :--- | :--- | :--- |
| **Max Scale** | 1.5x | Target magnification for icons. |
| **Max Scale (Sep)** | **1.0x** | GAUSSIAN V13: Separators do not scale, only move. |
| **Sigma (σ)** | 150 | GAUSSIAN V14: Master Sigma for organic flow. |
| **Threshold** | **1.005** | GAUSSIAN V14+: Master floor to settle vibrations. |
| **Growth Origin** | Bottom | Icons grow upwards via `transform-origin: bottom`. |
| **Vertical Space**| **160px**  | GAUSSIAN V15: Expanded headspace to prevent clipping. |
| **Formula** | `1 + ((max - 1) * exp(-(dist^2) / (2 * sigma^2)))` | `dist` = mouseX - virtualCenter. |

## 3. Geometry & Spacing (80px Slot Model)
To ensure zero-shift layout stability, we use a "Virtual Grid" where every icon has a fixed-width slot.

- **Icon Size (Base)**: `64px`
- **Slot Width (Base)**: `80px`
    - *Calculation*: `64px (Icon) + 16px (Proportional Padding)`.
- **Proportional Scaling**: GAUSSIAN V15: `Width_actual = Slot_base * Scale`. (1:1 Ratio). This ensures the "Gap" expands fluidly.
- **Static Ground Truth**: Distances are calculated against fixed **resting** centers (`staticCenter`), preventing the feedback loop.
- **Headroom**: The Window, Bar, and Item containers are all set to **160px** height pinned to the bottom.

## 4. Separator Specifications
- **Base Width**: `48px` (Hitbox) / `2px` (Visible Line).
- **Margins**: `15px` start/end for the visible line inside the hitbox.
- **Magnification**: Scales horizontally on the X-axis same as icons.

## 5. Background (The Glass Pill)
The background is an `Ags.DrawingArea` that renders a blurred, frosted-glass capsule.

- **Dynamic Width**: The background width is decoupled from the layout.
- **Inertia Smoothing**: Background width uses the same **0.15 Lerp** to transition between sizes, preventing "snapping" during rapid mouse movement.
- **Vertical Padding**: Fixed height `height_request: 92` (matching icons).
- **Positioning**: Centered relative to the `Virtual Grid`.

## 6. Virtual Grid / Ground Truth coordinates
The dock calculates mouse interaction using "Virtual Centers" calculated at layout time:

1. Calculate total width: `sum(configs[i].width)`.
2. Offset from monitor edge: `startX = (monitorWidth - totalWidth) / 2`.
3. Virtual Center for item `i`: `startX + sum(widths[0...i-1]) + (widths[i] / 2)`.

This ensures **1:1 mouse parity** even if widgets are rendered with different internal offsets.
