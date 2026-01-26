import gi
gi.require_version('Gtk', '4.0')
from gi.repository import Gtk, Gdk, GdkPixbuf

def measure_icon(icon_name, size):
    theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default())
    icon_paintable = theme.lookup_icon(
        icon_name,
        None,
        size,
        1,
        Gtk.TextDirection.NONE,
        Gtk.IconLookupFlags.FORCE_REGULAR
    )
    
    if not icon_paintable:
        print(f"Error: Icon {icon_name} not found")
        return

    # Snapshot to texture -> pixbuf
    # (Simplified: Just load the file if we can find it, standardized way is harder in pure Gtk4 script without main loop)
    # Let's try loading common files directly to avoid async paintable issues in script
    
    # Common paths for standard icons
    import os
    found_path = None
    search_paths = [
        f"/usr/share/icons/Adwaita/{size}x{size}/apps/{icon_name}.png",
        f"/usr/share/icons/hicolor/{size}x{size}/apps/{icon_name}.png",
        f"/usr/share/icons/Papirus/{size}x{size}/apps/{icon_name}.png",
        f"/usr/share/icons/Yaru/{size}x{size}/apps/{icon_name}.png",
    ]
    # Also svg
    
    for p in search_paths:
        if os.path.exists(p):
            found_path = p
            break
            
    if not found_path:
        # Try finding via find command because paths vary widely
        import subprocess
        try:
            cmd = f"find /usr/share/icons -name {icon_name}.png | grep {size}x{size} | head -n 1"
            out = subprocess.check_output(cmd, shell=True).decode().strip()
            if out: found_path = out
        except:
            pass

    if not found_path:
        print(f"Could not find file for {icon_name} at {size}px")
        return

    print(f"Analyzing {found_path}...")
    pixbuf = GdkPixbuf.Pixbuf.new_from_file(found_path)
    w, h = pixbuf.get_width(), pixbuf.get_height()
    pixels = pixbuf.get_pixels()
    stride = pixbuf.get_rowstride()
    n_channels = pixbuf.get_n_channels()
    
    min_x, max_x = w, 0
    min_y, max_y = h, 0
    
    has_alpha = (n_channels == 4)
    if not has_alpha:
        print("Image has no alpha channel, assumes full fill.")
        return 1.0

    # Brute force pixel walk
    for y in range(h):
        for x in range(w):
            offset = y * stride + x * n_channels
            # Alpha is usually last byte? GdkPixbuf is RGBA
            alpha = pixels[offset + 3]
            if alpha > 10: # Threshold
                if x < min_x: min_x = x
                if x > max_x: max_x = x
                if y < min_y: min_y = y
                if y > max_y: max_y = y

    content_w = max_x - min_x + 1
    content_h = max_y - min_y + 1
    
    fill_ratio_w = content_w / w
    fill_ratio_h = content_h / h
    
    print(f"METRICS for {icon_name} ({size}x{size}):")
    print(f"  Bounding Box: {min_x},{min_y} - {max_x},{max_y}")
    print(f"  Content Dims: {content_w}x{content_h}")
    print(f"  Fill Ratio: W={fill_ratio_w:.2f}, H={fill_ratio_h:.2f}")
    print(f"  AVG FILL: {(fill_ratio_w + fill_ratio_h)/2:.2f}")

measure_icon("org.gnome.nautilus", 24)
measure_icon("utilities-terminal", 24)
measure_icon("system-settings", 24)
