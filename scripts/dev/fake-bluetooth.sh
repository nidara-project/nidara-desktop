#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# fake-bluetooth.sh — DEV ONLY. Stand up a mock org.bluez so the Bluetooth
# settings page can be exercised without a real Bluetooth adapter.
#
# Unlike Wi-Fi (mac80211_hwsim is a real kernel radio stack), AstalBluetooth only
# ever talks to BlueZ over the *system* D-Bus. So instead of emulating a
# controller we replace org.bluez wholesale with python-dbusmock's bluez5
# template, which lets us inject fake adapters + devices + pairing state. This is
# the same approach GNOME uses to test its Bluetooth panel.
#
# Requires: python-dbusmock (pacman -S python-dbusmock). Must run as root, both
# to stop bluetooth.service and to own org.bluez on the system bus.
#
# Scenario created by `start`:
#   adapter hci0 "Nidara Test" (powered)
#   • Nidara Keyboard — paired, disconnected   (My devices → Connect/Disconnect)
#   • Nidara Mouse    — paired, disconnected   (My devices → Connect/Disconnect)
#   • Nidara Phone    — unpaired               (Nearby → Pair)
#
# Usage:  sudo ./fake-bluetooth.sh start
#         sudo ./fake-bluetooth.sh stop
#
# After `start`, reload the shell (Super+Shift+R) so AstalBluetooth re-binds to
# the new org.bluez owner, then open Settings → Bluetooth.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PIDFILE="/tmp/nidara-bluez-mock.pid"
ADAPTER="hci0"
MOCK="org.bluez.Mock"

#        address | alias | paired
# NOTE: devices are created paired-but-disconnected (or unpaired). We deliberately
# do NOT pre-connect any device via the Mock.ConnectDevice control method: that
# method updates the DBus *property* store but not the template's internal
# `device.connected` attribute, while the UI's Connect/Disconnect buttons go
# through Device1.Connect/Disconnect, whose guards read that attribute. Mixing the
# two desyncs the device and makes the UI buttons raise AlreadyConnected /
# NotConnected. Starting everything disconnected keeps the UI path self-consistent,
# so Connect → Disconnect via the buttons updates live. (Pairing uses the proper
# UpdateProperties path, so Pair works either way.)
dev=(
  "AA:BB:CC:00:00:01|Nidara Keyboard|yes"
  "AA:BB:CC:00:00:02|Nidara Mouse|yes"
  "AA:BB:CC:00:00:03|Nidara Phone|no"
)

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo." >&2; exit 1; fi

mock_call() { busctl --system call org.bluez /org/bluez "$MOCK" "$@" >/dev/null; }

case "${1:-}" in
  start)
    python3 -c "import dbusmock.templates.bluez5" 2>/dev/null \
      || { echo "python-dbusmock (bluez5 template) missing: pacman -S python-dbusmock" >&2; exit 1; }

    # Free the org.bluez name so the mock can own it.
    systemctl stop bluetooth.service 2>/dev/null || true

    echo "Starting bluez5 mock on the system bus…"
    python3 -m dbusmock --system --template bluez5 >/tmp/nidara-bluez-mock.log 2>&1 &
    echo $! > "$PIDFILE"

    # Wait for org.bluez to come up (mock owns the name + exposes /org/bluez).
    for _ in $(seq 1 50); do
      busctl --system introspect org.bluez /org/bluez >/dev/null 2>&1 && break
      sleep 0.2
    done
    busctl --system introspect org.bluez /org/bluez >/dev/null 2>&1 \
      || { echo "mock never claimed org.bluez — see /tmp/nidara-bluez-mock.log" >&2; exit 1; }

    mock_call AddAdapter ss "$ADAPTER" "Nidara Test"
    # Seed the DiscoveryFilter key: the bluez5 template's StartDiscovery reads
    # adapter.props[...]["DiscoveryFilter"] without initialising it, so a bare
    # Scan from the UI throws KeyError. Setting an (empty) filter creates the key.
    busctl --system call org.bluez "/org/bluez/$ADAPTER" org.bluez.Adapter1 \
        SetDiscoveryFilter "a{sv}" 0 >/dev/null 2>&1 || true

    for row in "${dev[@]}"; do
      IFS='|' read -r addr alias paired <<<"$row"

      mock_call AddDevice sss "$ADAPTER" "$addr" "$alias"
      [ "$paired" = "yes" ] && mock_call PairDevice ss "$ADAPTER" "$addr"
      echo "  + $alias ($addr) paired=$paired"
    done

    echo "Mock org.bluez up. Reload the shell (Super+Shift+R), then Settings → Bluetooth."
    echo "Stop with: sudo $0 stop"
    ;;

  stop)
    if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; fi
    pkill -f "dbusmock --system --template bluez5" 2>/dev/null || true
    rm -f /tmp/nidara-bluez-mock.log
    systemctl start bluetooth.service 2>/dev/null || true
    echo "Mock torn down; bluetooth.service restored. Reload the shell to re-bind."
    ;;

  *)
    echo "Usage: sudo $0 {start|stop}" >&2; exit 1 ;;
esac
