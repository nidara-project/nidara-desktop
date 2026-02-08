# MiDistroIA Dock Specification: Gaussian V136 (Purist Glass) 🧸🍎💎

This document defines the technical implementation, physics, and geometry of the Unified Dock Engine as of version 136 (Purist Glass Model).

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

## 5. Background Pill (The Glass) - V136 Purist Model
- **Single Source of Truth**: The background is rendered exclusively by the `Gtk.DrawingArea` using Cairo. The legacy CSS container (`pillBg`) has been removed to eliminate double-background artifacts.
- **Shape Logic**: Uses a **Superellipse (n=3.2)** with full-height radius (`r=0.5h`) to achieve a perfect "Continuous Curve" aesthetic (Squircle Pill), distinct from standard geometric rounded rectangles.
- **Material**: Translucent white fill (`alpha=0.25`) to capture the system blur, with a subtle top-down gradient for volume. No strokes or borders are drawn.

## 6. Icon Policy & Resolution
- **Prioritization**: `.desktop` file paths > Theme Icons > Fallback Material Icons.
- **Resolution**: All icons are standardized to 128px internal buffers for high-quality downscaling.

## 7. Styling Refinements (V137 - macOS Matching)
- **Separator**: Reduced to a **1px hairline** with 25% opacity, matching the subtle divider of macOS.
- **Indicators**:
    - **Uniformity**: "Open" and "Focused" states use the exact same visual style (Solid Light Grey Dot).
    - **Geometry**: Increased size to **5px** diameter.
    - **No Glows**: Removed focus borders and glow effects to match the clean, flat aesthetic of the reference.
