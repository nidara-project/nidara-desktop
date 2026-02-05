# Workspace Cockpit Specification: Geometric Absolute 3.0 🛡️📏💎

The Workspace Cockpit is a high-fidelity visual overview of the system state, providing a 1:1 schematic representation of all workspaces.

## 1. Unified Metadata Normalization

The Cockpit solves the "Hyprland Metadata Dissonance" where focused monitors report coordinates differently than background monitors.

### 1.1. The De-Focus Normalizer (Poppinson Transform)
Hyprland reports window data in two modes:
- **Focused Monitor**: Coordinates are **Workarea-Relative** (relative to the space *between* the Bar and Dock).
- **Background Monitor**: Coordinates are **Physical-Monitor-Relative** (relative to 0,0).

**The Solution:** The Cockpit implements a mathematical transform that adds the monitor's workarea offsets (e.g., +44px for the Bar) back into the window data *only* when the monitor is focused. This unifies all data into a single **Invariant Physical Grid**.

## 2. Geometry & Scaling

### 2.1. Invariant Physical Baseline
To prevent layout jitter caused by dynamic monitor metadata, the Cockpit anchors its math to a persistent **Real-World Reality Map**:
- **Baseline Resolution**: 2560x1440 (XV272U standard).
- **Reserved Areas**: 
  - Top Bar: 44px
  - Bottom Dock: 104px (Exclusive Zone).

### 2.2. Liquid Schematic Projection
The schematics use a fluid expansion engine (`hexpand`) that adapts to the available slot size (approx. 172px wide).
- **Dynamic Factor**: `scale = widget.render_width / monitor.logical_width`.
- **Real-time Re-scaling**: If the widget size changes, the schematic re-projects all windows instantly to maintain pixel-perfect alignment.

## 3. Visual Components

| Class | Description |
| :--- | :--- |
| `.wo-schematic-preview` | The main container with dashed calibration border. |
| `.wo-schematic-reserved` | Translucent markers showing the Bar (Top) and Dock (Bottom) zones. |
| `.wo-schematic-win` | Individual window boxes with wordmark labels. |
| `.focused` | High-contrast highlight for the window that currently has keyboard focus. |

## 4. Stability Engine (Anti-Jitter)

- **Integer Snapping**: All calculated screen positions are snapped using `Math.round` BEFORE being passed to `Gtk.Fixed.put/move` to prevent sub-pixel blurring.
- **Surface Isolation**: The Cockpit operates as a standalone `OVERLAY` window with `exclusive_zone: 0`, ensuring it floats above all other UI elements without affecting desktop tiling.

---

*Documento técnico de arquitectura. Actualizado el 05/02/2026.*
