/**
 * DistroIA - Icon Mapper (V126: Mapping Disabled)
 * This module is now a pass-through to ensure all applications use their
 * original system icons without hardcoded interference.
 */

/**
 * Returns the original icon name. Mapping is currently disabled 
 * to prioritize natural system branding.
 */
export function getMappedIcon(iconName: string, appId: string = "", appName: string = ""): string {
    return iconName;
}
