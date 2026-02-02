# MiDistroIA Dock Specification: Gaussian V90 (Zero-Vibration) 🧸🍎💎

This document defines the technical implementation, physics, and geometry of the Unified Dock Engine as of version 90 (Global Tiling Engine).

## 1. Core Architecture: Unified Animation Engine
The dock uses a **Single Central Clock (60fps)** to synchronize all animations. Version 90 introduces the **Global Tiling Engine** to eliminate sub-pixel vibration.

## 2. Physics & Constants
The magnification follows a Gaussian (Sine-based) curve anchored to the **Hybrid Physics Engine**.

| Parameter | Value | Description |
| :--- | :--- | :--- |
| **Physical Base** | **64px** | Resting icon size for maximum stability. |
| **Max Scale** | **2.0x** | Target magnification (128px / 64px = 2.0). |
| **Algorithm** | **Sine-Wave** | Cos-based easing for organic falloff. |
| **Range (Spread)**| **2.5** | Sigma spread relative to icon size. |
| **Base Slot (App)**| **80px** | Fixed base width (64px + 8px * 2 margins). |
| **Separator Slot**| **40px** | Fixed base width for separators. |

## 3. Geometric Stability (V90 Tiling Engine)
To achieve zero-vibration, the dock bypasses standard relative layout rounding:

- **Global Tiling**: Each item's horizontal `start` and `end` coordinates are calculated as absolute floating-point values from the dock's origin (0.0). These are snapped to the global pixel grid (`Math.round`) *before* widget sizes are applied.
- **Manual Pixel-Centering**: Standard `halign: CENTER` is disabled (`halign: START` is enforced). The dock bar's position is manually calculated as `Math.round((monitorWidth - totalIntWidth) / 2)` to prevent 0.5px "parity jitter".
- **Zero Gaps**: This approach ensures every icon is mathematically adjacent to its neighbor with exactly 0px overlap or gap at the pixel level.

## 4. Separator Specifications
- **Base Slot**: `40px` (Hitbox/Slot).
- **Visible Line**: `2px` width, `48px` height (Translucent White @ 40%).
- **Alignment**: Centered in its slot via the Tiling Engine. Scale is locked to 1.0x.

## 5. Background Pill (The Glass)
- **Integer-Perfect Sync**: The background width is calculated as the literal sum of the integer-snapped icon slot widths.
- **Lockstep Movement**: Because the background uses the same integer values as the icons, they move in perfect synchrony with zero relative vibration.

## 6. Layout Synchronization (V90 Master)
The `runUnifiedTick` loop handles all geometric updates. CSS transitions on layout properties (`width`, `margin`) are disabled to ensure the JS physics engine has absolute authority over the frame-by-frame rendering.
