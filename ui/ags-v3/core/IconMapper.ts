/**
 * DistroIA - Smart Icon Aliasing (V94)
 * Only handles name-to-name shifts. The system theme (DistroIA) handles rendering.
 */

// Branded apps that should NEVER be touched/remapped
const BRAND_BLACKLIST = new Set([
    "google-chrome", "com.google.Chrome", "google-chrome-unstable",
    "firefox", "org.mozilla.firefox", "firefox-esr",
    "spotify", "com.spotify.Client",
    "discord", "com.discordapp.Discord",
    "telegram", "org.telegram.desktop", "telegram-desktop",
    "code", "visual-studio-code", "vscode", "codium",
    "steam", "com.valvesoftware.Steam",
    "slack", "com.slack.Slack",
    "whatsapp", "whatsapp-desktop",
    "vlc", "org.videolan.VLC",
    "gimp", "org.gimp.GIMP",
    "blender", "org.blender.Blender",
    "obsidian", "md.obsidian.Obsidian",
    "mongodb", "postman", "insomnia",
    "kitty", "alacritty", "terminator",
    "brave", "brave-browser",
    "opera", "microsoft-edge",
]);

const MAPPINGS: Record<string, string> = {
    // SYSTEM & TOOLS
    "gnome-control-center": "settings",
    "org.gnome.Nautilus": "folder",
    "nautilus": "folder",
    "org.gnome.Terminal": "terminal",
    "gnome-terminal": "terminal",
    "gedit": "edit",
    "org.gnome.gedit": "edit",
    "org.gnome.Weather": "cloud",
    "org.gnome.Software": "grid_view",
    "distributor-logo": "apps",
    "user-home": "home",
    "folder-home": "home",
    "folder-open": "folder_open",
    "system-file-manager": "home",
    "rhythmbox": "library_music",
    "org.gnome.Rhythmbox3": "library_music",
    "gnome-terminal-server": "terminal",
    "wlogout": "power_settings_new",
    // NO WEB SERVICES HERE - PWAs MUST USE THEIR OWN ICONS
};

/**
 * Returns the alias name for the icon theme, or the original name.
 */
export function getMappedIcon(iconName: string, appId: string = "", appName: string = ""): string {
    // V126: Icon mapping disabled. We prefer original system icons.
    return iconName;

    const cleanId = appId.toLowerCase().replace(".desktop", "");
    const cleanName = iconName.toLowerCase();

    if (BRAND_BLACKLIST.has(cleanId) || BRAND_BLACKLIST.has(cleanName)) {
        return iconName;
    }

    // STRICT MAPPINGS ONLY
    if (MAPPINGS[appId]) return MAPPINGS[appId];
    if (MAPPINGS[cleanId]) return MAPPINGS[cleanId];
    if (MAPPINGS[iconName]) return MAPPINGS[iconName];
    if (MAPPINGS[cleanName]) return MAPPINGS[cleanName];

    return iconName;
}
