#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# fake-wifi.sh — DEV ONLY. Spin up a virtual Wi-Fi AP to exercise the Network
# settings page without real hardware.
#
# Requires: mac80211_hwsim loaded with >=2 radios, hostapd, NetworkManager.
#   sudo modprobe mac80211_hwsim radios=2
#   sudo pacman -S hostapd
#
# Layout: wlan1 = the fake AP (taken out of NM, driven by hostapd)
#         wlan0 = the client (left to NetworkManager → the page scans/connects)
#
# Why wlan1 is the AP, not wlan0: libastal-network's get_device() returns the
# FIRST wifi device when none has an active connection (network.vala) — i.e.
# wlan0. The Network page therefore watches wlan0, so wlan0 must be the scanning
# client and wlan1 the broadcaster.
#
# Usage:  sudo ./fake-wifi.sh start   # broadcast "CrystalTest" (WPA2)
#         sudo ./fake-wifi.sh stop    # tear down, give wlan0 back to NM
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

AP_IFACE="wlan1"
SSID="CrystalTest"
PASSPHRASE="crystal123"
CHANNEL="6"
COUNTRY="ES"   # world domain "00" forbids AP/beaconing on 2.4GHz (NO-IR); pick a real country
CONF="/tmp/crystal-hostapd.conf"
PIDFILE="/tmp/crystal-hostapd.pid"
DNSMASQ_PID="/tmp/crystal-dnsmasq.pid"
GATEWAY="10.42.0.1"      # AP-side address; client gets DHCP from this subnet
DHCP_LO="10.42.0.10"
DHCP_HI="10.42.0.100"

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo." >&2; exit 1; fi

case "${1:-}" in
  start)
    command -v hostapd >/dev/null || { echo "hostapd not installed: pacman -S hostapd" >&2; exit 1; }
    ip link show "$AP_IFACE" >/dev/null 2>&1 || { echo "$AP_IFACE missing — modprobe mac80211_hwsim radios=2" >&2; exit 1; }

    # Hand wlan0 to hostapd: NM must not manage it.
    nmcli device set "$AP_IFACE" managed no || true
    rfkill unblock wlan || true

    # The kernel boots in world domain "00", which sets NO-IR on 2.4GHz and stops
    # hostapd from ever beaconing (wlan0 stays "type managed"). Pin a real country.
    iw reg set "$COUNTRY" || true
    sleep 1

    cat > "$CONF" <<EOF
interface=$AP_IFACE
driver=nl80211
ssid=$SSID
country_code=$COUNTRY
ieee80211d=1
hw_mode=g
channel=$CHANNEL
auth_algs=1
wpa=2
wpa_passphrase=$PASSPHRASE
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
EOF

    echo "Starting hostapd on $AP_IFACE → SSID '$SSID' (WPA2, pass: $PASSPHRASE)"
    hostapd -B -P "$PIDFILE" "$CONF"
    sleep 1

    # hostapd is layer-2 only. Without DHCP the client associates but never gets an
    # IP, so NetworkManager fails the activation ("IP configuration could not be
    # reserved") and the page bounces Connect → Error. Give the AP an address and
    # serve DHCP with dnsmasq so the client lands a real IP and NM reports connected.
    ip addr flush dev "$AP_IFACE" 2>/dev/null || true
    ip addr add "$GATEWAY/24" dev "$AP_IFACE"
    ip link set "$AP_IFACE" up
    dnsmasq --interface="$AP_IFACE" --bind-interfaces --except-interface=lo \
        --no-resolv --no-hosts --dhcp-authoritative \
        --dhcp-range="$DHCP_LO,$DHCP_HI,255.255.255.0,12h" \
        --dhcp-option=3,"$GATEWAY" \
        --pid-file="$DNSMASQ_PID"

    echo "AP up + DHCP serving $DHCP_LO–$DHCP_HI. In Settings → Network, hit Scan."
    echo "Stop with: sudo $0 stop"
    ;;

  stop)
    if [ -f "$DNSMASQ_PID" ]; then kill "$(cat "$DNSMASQ_PID")" 2>/dev/null || true; rm -f "$DNSMASQ_PID"; fi
    pkill -f "dnsmasq --interface=$AP_IFACE" 2>/dev/null || true
    if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; fi
    pkill -f "hostapd .*crystal-hostapd.conf" 2>/dev/null || true
    rm -f "$CONF"
    ip addr flush dev "$AP_IFACE" 2>/dev/null || true
    nmcli device set "$AP_IFACE" managed yes || true
    echo "AP + DHCP torn down; $AP_IFACE returned to NetworkManager."
    ;;

  *)
    echo "Usage: sudo $0 {start|stop}" >&2; exit 1 ;;
esac
