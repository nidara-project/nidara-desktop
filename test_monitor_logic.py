import os
import sys
import json
from core.wm.factory import get_window_manager

os.environ["XDG_SESSION_TYPE"] = "wayland"
os.environ["HYPRLAND_INSTANCE_SIGNATURE"] = "39f3feddbee4a66be9608ed1eb7e73878d596b50_1769281744_1313009542"

wm = get_window_manager()
windows = wm.get_windows()
print(json.dumps(windows))
