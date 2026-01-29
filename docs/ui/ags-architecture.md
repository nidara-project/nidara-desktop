# Arquitectura de UI con AGS (v3 / Astal)

DistroIA utiliza la versión moderna de AGS (v3+), basada en el ecosistema **Astal**. Esta versión es superior para el manejo de desenfoques (blur) en Ubuntu 24.04.

## 1. Diferencias Clave (v3 vs v1)
- **Comando**: Se utiliza `ags run` en lugar de simplemente `ags`.
- **Lenguaje**: Soporte nativo y recomendado para **TypeScript**.
- **Importaciones**: Se utilizan módulos modernos (ESM) en lugar de `imports.gi`.
- **Estructura**: Basado en librerías `astal` independientes para cada servicio (Hyprland, Mpris, etc.).

## 2. Estructura del Proyecto Astal
```text
~/.config/ags/
├── app.ts             # Punto de entrada
├── style.scss         # Estilos compilados
├── widget/            # Componentes (Dock, Bar, etc.)
└── lib/               # Utilidades y lógica
```

## 3. Principios de DistroIA (v3)
- **Declarativo**: Usar la sintaxis de Astal para definir widgets.
- **Glassmorphism**: El soporte de blur es nativo a través de la propiedad `Gtk.Window` configurada con LayerShell.
- **Integración IA**: La arquitectura modular de Astal facilita inyectar servicios de IA local mediante GDBus.
