# MiDistroIA Dock Specification: Gaussian V51 (Stability & Symmetry) 🧸🍎💎

This document defines the technical implementation, physics, and geometry of the Unified Dock Engine as of version 51 (Precision Stabilization).

## 1. Core Architecture: Unified Animation Engine
The dock uses a **Single Central Clock (60fps)** to synchronize all animations. This eliminates the phase-jitter caused by independent widget loops.

## 2. Physics & Constants
The magnification follows a Gaussian (Sine-based) curve anchored to the **Hybrid Physics Engine**.

| Parameter | Value | Description |
| :--- | :--- | :--- |
| **Physical Base** | **64px** | Resting icon size for maximum stability. |
| **Max Scale** | **2.0x** | Target magnification (128px / 64px = 2.0). |
| **Algorithm** | **Sine-Wave** | Cos-based easing for organic falloff. |
| **Range (Spread)**| **2.5** | Sigma spread relative to icon size. |
| **Dynamic Margin**| **8px (Base)**| Margins shrink as icons grow to maintain cohesion. |
| **Vertical Space**| **160px**  | GAUSSIAN V50: Expanded headspace to prevent clipping. |
| **Formula** | `cos(normDist * PI/2)^2` | Mapped 0-1 intensity. |

## 3. Geometry & Symmetry (Hybrid 80/64 Model)
To ensure absolute horizontal symmetry and zero-jitter, we use a **Hybrid Layout Model**:

- **Layout Slot (Logical)**: Exactly **80px** for every item (Apps, Separator, Trash).
- **Icon Rendering (Physical)**: **64px** (Icon) + **8px** (Left Margin) + **8px** (Right Margin).
- **Stability Formula**: `64 + 8 + 8 = 80`. Since the physical size matches the logical slot perfectly at rest, there is **zero-shift** (baile) when interaction begins.
- **Static Ground Truth**: Centers are calculated against fixed **80px** slots (`staticCenter`), ensuring the separator remains mathematically equidistant.

## 4. Separator Specifications
- **Base Slot**: `80px` (Hitbox/Slot).
- **Visible Line**: `1px` (Translucent White @ 40%).
- **Alignment**: Mathematically centered in the 80px slot and vertically centered in the 92px background pill.
- **Behavior**: Scale is locked to 1.0x to satisfy the "macOS Anchor" principle.

## 5. Background Pill (The Glass)
- **Summation Logic**: Sum of all `currentWidth + (currentMargin * 2)` across all slots + 12px padding.
- **Smoothing**: The background width has its own inertia (lerp 0.2) to follow the layout fluidly.

## 6. Layout Synchronization (V50 Master)
The `Gtk.Revealer` base and the `DockItem` internal state are synchronized frame-by-frame. The `update` loop uses **V10 Precision Arithmetic** to recalculate global centers every time the application list or focus changes.
