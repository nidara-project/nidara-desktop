import Widget from 'resource:///com/github/Aylur/ags/widget.js';
import Hyprland from 'resource:///com/github/Aylur/ags/service/hyprland.js';
import Applications from 'resource:///com/github/Aylur/ags/service/applications.js';
import Utils from 'resource:///com/github/Aylur/ags/utils.js';

const { GLib, Gdk, Gtk } = imports.gi;

/**
 * DockItem: Individual icon widget with magnification capability
 */
const DockItem = (app) => {
    // Base size 42px as planned in Python version for better contrast
    const size = 42;
    const icon = Widget.Icon({
        icon: app.icon_name || 'application-x-executable',
        size: size,
        className: 'dock-icon',
    });

    const button = Widget.Button({
        className: 'dock-item',
        child: Widget.Box({
            vertical: true,
            children: [
                icon,
                Widget.Box({
                    className: 'indicator',
                    // Logic for active state could go here
                })
            ]
        }),
        onClicked: () => app.launch(),
        tooltipText: app.name,
    });

    // Parabolic Magnification Implementation
    button.on('motion-notify-event', (widget, event) => {
        const [_, x] = event.get_coords();
        const center = widget.get_allocation().width / 2;
        const dist = Math.abs(x - center);

        // Gaussian Curve (Sigma 60 as tuned in Python)
        const sigma = 60;
        const scale = 1 + (1.6 - 1) * Math.exp(-(dist ** 2 / (2 * sigma ** 2)));

        icon.size = Math.floor(size * scale);
    });

    button.on('leave-notify-event', () => {
        icon.size = size;
    });

    return button;
};

export const Dock = () => Widget.Window({
    name: 'ags-dock',
    anchor: ['bottom'],
    layer: 'bottom',
    exclusivity: 'exclusive',
    namespace: 'distroia-dock',
    child: Widget.Box({
        className: 'dock-container',
        children: [
            // Menu/Launcher
            Widget.Button({
                className: 'dock-item launcher-button',
                child: Widget.Icon({ icon: 'view-app-grid-symbolic', size: 32 }),
                onClicked: () => Utils.execAsync('wofi --show drun'),
            }),

            // Pinned Apps (Favorites)
            Widget.Box({
                spacing: 8,
                children: Applications.query('').slice(0, 8).map(DockItem),
            }),
        ],
    }),
});
