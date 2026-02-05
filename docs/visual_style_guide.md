# Guía de Estilo Visual (Reference Image)
Ese nivel de "Unix Porn" se consigue combinando transparencias, blur y aplicaciones de terminal (TUI).

## 1. Las Apps de la imagen:
*   **Terminal**: `kitty` (Es la que mejor gestiona las transparencias e imágenes).
*   **Info del Sistema** (Arriba Dcha): `fastfetch` (Una versión moderna de neofetch).
*   **Monitor de Recursos** (Centro Dcha): `btop` (Monitor muy gráfico y personalizable).
*   **Git** (Abajo Dcha/Izq): `lazygit` (Interfaz de terminal para git).
*   **Editor** (Izquierda): Parece **VS Code** con el fondo transparente (plugin 'GlassIt-VSC') o **Neovim** muy modificado.

## 2. Cómo conseguir las Transparencias (Hyprland):

Para que todo se vea así de cristalino, usamos el "Apple Core" config en `hyprland.conf`:

```ini
decoration {
    rounding = 18              # Radio "Squircle" oficial de Apple
    active_opacity = 0.85      # El cristal debe dejar pasar la luz
    inactive_opacity = 0.90    # Menos transparente para foco visual

    blur {
        enabled = true
        size = 10              # Radio más amplio para dispersión sedosa
        passes = 4             # Mínimo 4 pases para evitar "ruido" en el desenfoque
        ignore_opacity = true
        new_optimizations = true
        
        # --- EL SECRETO DE APPLE ---
        vibrancy = 0.25        # Realza los colores que atraviesan el cristal
        vibrancy_darkness = 0.1 # Mantiene los negros elegantes
        contrast = 1.1         # Da profundidad al contenido sobre el cristal
        brightness = 1.2       # El cristal de Apple suele "emitir" algo de luz
    }

    shadow {
        enabled = true         # Apple usa sombras profundas pero suaves
        range = 30
        render_power = 3
        color = rgba(00000044) # Sombra aireada, no sólida
    }
}
```

## 3. Para VS Code Transparente:
Instala la extensión **"GlassIt-VSC"** y ajusta la opacidad con `Ctrl + Alt + Z`.

---
¿Quieres que instalemos `fastfetch` y `btop` para que tu terminal empiece a verse así?
