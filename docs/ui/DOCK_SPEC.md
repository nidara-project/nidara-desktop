# MiDistroIA Dock Specification: Gaussian V16 🧸🍎💎

This document defines the technical implementation, physics, and geometry of the Unified Dock Engine as of version 16 (Master Formula).

## 1. Core Architecture: Unified Animation Engine
The dock uses a **Single Central Clock (60fps)** to synchronize all animations. This eliminates the phase-jitter caused by independent widget loops.

## 2. Physics & Constants
The magnification follows a Gaussian curve anchored to a **Static Ground Truth Grid**.

| Parameter | Value | Description |
| :--- | :--- | :--- |
| **Max Scale** | **2.0x** | Target magnification (128px / 64px = 2.0). |
| **Algorithm** | **Sine-Wave** | Cos-based easing for organic falloff. |
| **Range (Spread)**| **2.5** | Sigma spread relative to icon size. |
| **Dynamic Margin**| **Yes** | Margins shrink as icons grow to maintain cohesion. |
| **Overlap Ratio** | **0.8x** | Slot growth vs Icon growth for premium overlap. |
| **Vertical Space**| **160px**  | GAUSSIAN V16: Expanded headspace to prevent clipping. |
| **Formula** | `cos(normDist * PI/2)^2` | Mapped 0-1 intensity. |

## 3. Geometry & Spacing (80px Slot Model)
To ensure zero-shift layout stability, we use a "Virtual Grid" where every icon has a fixed-width slot.

- **Icon Size (Base)**: `64px`
- **Slot Width (Base)**: `80px`
    - *Calculation*: `64px (Icon) + 16px (Proportional Padding)`.
- **Overlap Physics (0.8x)**: `Width_actual = Slot_base + (Slot_base * (Scale - 1) * 0.8)`.
- **Static Ground Truth**: Distances are calculated against fixed **resting** centers (`staticCenter`), preventing the feedback loop.
- **Headroom**: The Window, Bar, and Item containers are all set to **160px** height pinned to the bottom.

## 4. Separator Specifications
- **Base Width**: `48px` (Hitbox) / `2px` (Visible Line).
- **Behavior**: Horizontal shift only. Scaling is locked to 1.0x to stabilize the layout.

## 5. Background Pill (The Glass)
- **Summation Logic**: The background width is the sum of all current slot widths + 32px padding.
- **Smoothing**: The background width has its own inertia to follow the layout fluidly.

## 6. Layout Synchronization (V12.1+)
The `Gtk.Revealer` wrapper for each item is forced to synchronize its `width_request` with the `itemBox` in every frame. This ensures that scaling icons correctly "push" their neighbors in Real-Time.
