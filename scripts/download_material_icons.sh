#!/bin/bash
ASSETS_DIR="/home/angel/Dev/MiDistroIA/assets/icons/material"
mkdir -p "$ASSETS_DIR"

ICONS=(
    "settings" "search" "home" "menu" "close" "add" "check" "done" "info" "help" "visibility" "visibility_off"
    "edit" "delete" "save" "share" "link" "download" "upload" "cloud" "cloud_upload" "cloud_download"
    "folder" "folder_open" "description" "image" "video_library" "music_note" "library_music" "movie"
    "terminal" "grid_view" "apps" "widgets" "dashboard" "calculate" "event" "calendar_today" "schedule" "alarm"
    "notifications" "notifications_active" "mail" "chat" "forum" "call" "contact_page" "person" "group"
    "browser" "language" "public" "star" "bookmark" "history" "history_edu" "print" "send" "archive" "unarchive"
    "volume_up" "volume_down" "volume_off" "volume_mute" "mic" "videocam" "camera_alt" "photo_camera"
    "play_arrow" "pause" "stop" "skip_next" "skip_previous" "forward_10" "replay_10" "shuffle" "repeat"
    "bluetooth" "wifi" "wifi_off" "battery_full" "battery_charging_full" "battery_alert" "battery_std"
    "desktop_windows" "smartphone" "tablet" "keyboard" "mouse" "headset" "tv" "watch" "speaker" "router"
    "light_mode" "dark_mode" "wb_sunny" "nightlight" "palette" "brush" "format_paint" "extension" "construction"
    "power_settings_new" "lock" "lock_open" "vpn_key" "security" "shield" "fingerprint" "verified_user"
    "shopping_cart" "store" "paid" "account_balance" "loyalty" "sell" "credit_card" "receipt" "assessment"
    "map" "navigation" "location_on" "place" "explore" "directions" "directions_run" "directions_walk" "directions_bike" "directions_car"
    "restaurant" "local_cafe" "local_bar" "local_hospital" "local_pharmacy" "local_shipping" "flight" "hotel"
    "school" "menu_book" "import_contacts" "work" "business_center" "campaign" "announcement" "error" "warning"
    "refresh" "sync" "loop" "timer" "speed" "bolt" "energy_savings_leaf" "eco" "science" "psychology"
    "visibility" "favorite" "thumb_up" "thumb_down" "grade" "build" "reorder" "list" "view_list" "view_module"
    "arrow_back" "arrow_forward" "arrow_upward" "arrow_downward" "expand_more" "expand_less" "chevron_right" "chevron_left"
    "login" "logout" "open_in_new" "file_download" "file_upload" "sort" "filter_list" "rotate_left" "rotate_right"
)

# Style: materialsymbolsoutlined
BASE_URL="https://raw.githubusercontent.com/google/material-design-icons/master/symbols/web"

echo "Downloading ${#ICONS[@]} Material Symbols..."

for icon in "${ICONS[@]}"; do
    if [ ! -f "$ASSETS_DIR/$icon.svg" ] || [ $(stat -c%s "$ASSETS_DIR/$icon.svg") -lt 100 ]; then
        echo "Fetching: $icon"
        curl -s -L -o "$ASSETS_DIR/$icon.svg" "$BASE_URL/$icon/materialsymbolsoutlined/${icon}_24px.svg"
    fi
done

echo "Download complete."
