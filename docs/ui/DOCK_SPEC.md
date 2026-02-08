# MiDistroIA Dock Specification: Gaussian V135 (Stable DrawingArea) 🧸🍎💎

This document defines the technical implementation, physics, and geometry of the Unified Dock Engine as of version 135 (Stable DrawingArea Model).

## 1. Core Architecture: Unified Animation Engine
The dock uses a **Single Central Clock (60fps)** to synchronize all animations. Version 135 introduces the **Custom DrawingArea Renderer** to solve icon scaling artifacts.

### 1.1 Modular Code Structure
To maintain code quality and separation of concerns, the Dock is split into three main modules:
- **`Dock.tsx`**: The main entry point. Handles the window creation (`Gtk4LayerShell`), the physics engine loop ("Unified Tick"), and the high-level application list generation.
- **`DockItem.tsx`**: Contains the `DockItem` component. 
  - **Renderer**: Uses a `Gtk.DrawingArea` with a custom Cairo draw function.
  - **State**: Manages its own local state (hover, click, menu) and Drag & Drop logic.
- **`DockPhysics.ts`**: Core physics constants and the Gaussian magnification algorithm.
- **`DockUtils.ts`**: Graphic utilities (Cairo `drawSquircle`).

## 2. Physics & Constants
The magnification follows a Gaussian (Sine-based) curve anchored to the **Hybrid Physics Engine**.

| Parameter | Value | Description |
| :--- | :--- | :--- |
| **Physical Base** | **64px** | Resting icon size (`minSize`). |
| **Max Scale** | **1.5x** | Target magnification (96px / 64px = 1.5). |
| **Pill Height** | **100px** | Visual container height. |
| **App Slot** | **82px** | Base width for layout calculations. |

### 2.1 Icon Rendering Strategy (V135)
To ensure pixel-perfect scaling without "popping" (swapping assets), we use a **Manual Rendering Pipeline**:
1.  **High-Res Caching**: Icons are loaded *once* as a `GdkPixbuf` at **128px** (2x retina quality).
2.  **Internal Padding Enforcement**: 
    -   The `DrawingArea` widget is set to `Gtk.Align.FILL` to occupy the full "Plate" container.
    -   The `draw_func` mathematically enforces an **80% scale** (0.65 for special logos like Antigravity) relative to the allocated size.
    -   This guarantees a perfectly centered icon with consistent "breathing room" (transparency) between the icon and the squircle plate edge, regardless of the container's layout size.

## 3. Geometric Stability (Zero-Vibration Logic)
To achieve zero-vibration and eliminate "jitter":

1. **Global Tiling Engine**: Floating-point coordinates snapped to integers (`Math.round`) for positioning.
2. **Manual Centering**: The container's `margin_start` is calculated manually every frame to keep it centered on the monitor.
3. **Internal Drawing**: By decoupling the "Layout Size" (Plate) from the "Visual Size" (Icon drawn inside), we eliminate layout shifts caused by padding adjustments.

## 4. Seamless Overlap Model
To prevent magnified icons from being cut off by the dock's window or other applications:
- **Window Layer**: `TOP` layer.
- **Exclusive Zone**: Locked to **110px** (100px + margin), allowing the top part of magnified icons to overlap applications safely.
- **Input Region**: Restricted to the visual pill area to avoid blocking clicks on underlying windows.

## 5. Background Pill (The Glass)
- **Gaussian Symmetric Alignment**: Icons are centered in the pill.
- **Lockstep Sync**: The background width moves in perfect synchrony with the sum of icon widths.

## 6. Icon Policy & Resolution
- **Prioritization**: `.desktop` file paths > Theme Icons > Fallback Material Icons.
- **Resolution**: All icons are standardized to 128px internal buffers for high-quality downscaling.

