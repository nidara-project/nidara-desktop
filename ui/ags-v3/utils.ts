import AstalHyprland from "gi://AstalHyprland"
import GLib from "gi://GLib"

/**
 * Robust Service Fetcher with Exponential Backoff 🛡️
 * Retries with increasing delays: 200ms, 400ms, 800ms, 1600ms, 3200ms
 */
export async function getServiceSafe<T>(getter: () => T, name: string): Promise<T | null> {
    const MAX_RETRIES = 5;
    const BASE_DELAY = 200;

    for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const service = getter();
            if (service) return service;
        } catch (e) {
            console.warn(`[Utils] Service ${name} not ready (attempt ${i + 1}/${MAX_RETRIES}), retrying...`);
        }
        // Exponential backoff: 200, 400, 800, 1600, 3200ms
        const delay = BASE_DELAY * Math.pow(2, i);
        await new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => { r(null); return GLib.SOURCE_REMOVE }));
    }
    console.error(`[Utils] Service ${name} failed to initialize after ${MAX_RETRIES} attempts`);
    return null;
}

/**
 * Parabolic Magnification Utils - Apple Signature Precision
 */

export function calculateIconSize(
    mouseX: number,      // Posicion global del raton
    itemX: number,       // Centro del icono
    itemWidth: number,   // Ancho base del item
    baseSize: number,    // Tamaño base (ej. 64)
    maxScale: number = 1.45, // Cuanto crece
    sigma: number = 220     // Radio de efecto (Ampliado para V27 - Apple Signature)
): number {
    if (mouseX < 0) return baseSize;

    const distance = Math.abs(mouseX - itemX);
    if (distance > sigma) return baseSize;

    // Curva Gaussiana Pura (Calculo de precision Apple)
    // El factor 0.45 proporciona una transicion mas organica y menos brusca
    const factor = Math.exp(-(distance * distance) / (2 * (sigma * 0.45) ** 2));
    const size = baseSize + (baseSize * (maxScale - 1) * factor);

    return size;
}

// Deprecated: getIconSize replaced by calculateIconSize
export function getIconSize(x: number, mouseRelX: number, baseSize: number, maxScale: number, sigma: number): number {
    return calculateIconSize(mouseRelX, x, 0, baseSize, maxScale, sigma);
}

/**
 * Wordmark Engine 🍎
 * Pretty names and sanitization for a premium look.
 */
export function getWordmark(client: AstalHyprland.Client | null, hyprland: AstalHyprland.Hyprland): string {
    if (!client) {
        const ws = hyprland.focused_workspace
        if (!ws) return "Workspace"
        const wsName: Record<string, string> = { gamespace: "Gaming" }
        return wsName[ws.name] ?? `Workspace ${ws.id}`
    }

    const classMap: Record<string, string> = {
        "google-chrome": "Google Chrome",
        "chrome-google.com": "Google Chrome",
        "firefox": "Firefox",
        "code-url-handler": "Visual Studio Code",
        "code": "Visual Studio Code",
        "thunar": "Archivos",
        "foot": "Terminal",
        "kitty": "Terminal",
        "nautilus": "Archivos",
        "pavucontrol": "Ajustes de Sonido",
        "nm-connection-editor": "Red",
        "org.gnome.Settings": "Ajustes",
        "vlc": "VLC Player",
        "spotify": "Spotify",
        "discord": "Discord",
        "telegram-desktop": "Telegram",
        "org.gnome.Calendar": "Calendario"
    }

    // 1. Prioritize Title for specific dynamic context (like Browser tabs or Folders)
    let title = client.title || ""

    // 2. Clear known suffixes to keep it clean
    const suffixes = [
        " — Mozilla Firefox",
        " - Google Chrome",
        " - Visual Studio Code",
        " - VSCodium",
        " - Terminal",
        " - File Manager"
    ]
    suffixes.forEach(s => { if (title.endsWith(s)) title = title.replace(s, "") })

    // 3. If title is too generic or empty, use class mapping
    const genericTitles = ["New Tab", "Google Chrome", "Mozilla Firefox", "Untitled", "index.html", "Enter name of file", ""]
    if (genericTitles.includes(title) || title.length < 2) {
        const cls = client.class || ""
        if (!cls) return ""
        return classMap[cls.toLowerCase()] ||
            cls.charAt(0).toUpperCase() + cls.slice(1)
    }

    return title
}
