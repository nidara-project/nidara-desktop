# Guía de Estilo Visual (Reference Image)
Ese nivel de "Unix Porn" se consigue combinando transparencias, blur y aplicaciones de terminal (TUI).

## 1. Las Apps de la imagen:
*   **Terminal**: `kitty` (Es la que mejor gestiona las transparencias e imágenes).
*   **Info del Sistema** (Arriba Dcha): `fastfetch` (Una versión moderna de neofetch).
*   **Monitor de Recursos** (Centro Dcha): `btop` (Monitor muy gráfico y personalizable).
*   **Git** (Abajo Dcha/Izq): `lazygit` (Interfaz de terminal para git).
*   **Editor** (Izquierda): Parece **VS Code** con el fondo transparente (plugin 'GlassIt-VSC') o **Neovim** muy modificado.

## 2. Cómo conseguir las Transparencias (Hyprland):
Para que todo se vea así de cristalino, edita `~/.config/hypr/hyprland.conf`:

```ini
decoration {
    rounding = 10
    
    # Opacidad (0.0 - 1.0)
    active_opacity = 0.90
    inactive_opacity = 0.80
    
    # Blur (El desenfoque del fondo es CLAVE)
    blur {
        enabled = true
        size = 6
        passes = 3 # Más pases = blur más suave y costoso
        new_optimizations = true
        ignore_opacity = true
    }
    
    # Sombras
    drop_shadow = true
    shadow_range = 15
    col.shadow = rgba(00000055)
}
```

## 3. Para VS Code Transparente:
Instala la extensión **"GlassIt-VSC"** y ajusta la opacidad con `Ctrl + Alt + Z`.

---
¿Quieres que instalemos `fastfetch` y `btop` para que tu terminal empiece a verse así?
