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
 * Parabolic magnification utils — smooth gaussian falloff around the cursor.
 */

export function calculateIconSize(
    mouseX: number,      // Posicion global del raton
    itemX: number,       // Centro del icono
    itemWidth: number,   // Ancho base del item
    baseSize: number,    // Tamaño base (ej. 64)
    maxScale: number = 1.45, // Cuanto crece
    sigma: number = 220     // Radio de efecto (ampliado en V27)
): number {
    if (mouseX < 0) return baseSize;

    const distance = Math.abs(mouseX - itemX);
    if (distance > sigma) return baseSize;

    // Curva Gaussiana pura (cálculo de alta precisión)
    // El factor 0.45 proporciona una transicion mas organica y menos brusca
    const factor = Math.exp(-(distance * distance) / (2 * (sigma * 0.45) ** 2));
    const size = baseSize + (baseSize * (maxScale - 1) * factor);

    return size;
}
