#!/usr/bin/env bash
# consent-portal-probe.sh — bin/nidara-portal's Access backend, off-screen.
#
# The consent prompt is drawn by the shell (ui/shell/surfaces/consent/ConsentService.ts);
# bin/nidara-portal only forwards it. This probe tests the forwarding half on an
# ISOLATED private bus, with a fake shell standing in for org.nidara.Shell.Consent:
#
#   a) the shell grants          → the backend answers (0, {choices})
#   b) the app closes the request → Close reaches the shell, the backend answers 1
#   c) no shell on the bus        → the backend answers 2 (denied), and does NOT hang
#
# Every case asserts; the script exits non-zero on the first surprise. Case (a) was
# the one that found the bug the backend's `finish()` comment describes: the reply
# threw while being packed, and the app hung until its D-Bus timeout.
#
# Isolation (see architecture.md → the appearance contract, and the dconf incident):
# the environment goes on the dbus-run-session command line, a dconf canary must land
# in the private database, and nothing here touches the live session.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d -t nidara-consent-probe-XXXXXX)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/runtime" "$work/config"; chmod 700 "$work/runtime"

cat > "$work/fakeshell.py" <<'EOF'
import sys
from gi.repository import Gio, GLib
MODE = sys.argv[1]   # grant | hold
XML = '''<node><interface name="org.nidara.Shell.Consent">
<method name="AccessDialog"><arg type="s" direction="in"/><arg type="s" direction="in"/>
<arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/>
<arg type="s" direction="in"/><arg type="a{sv}" direction="in"/>
<arg type="u" direction="out"/><arg type="a{sv}" direction="out"/></method>
<method name="Close"><arg type="s" direction="in"/></method></interface></node>'''
pending = {}
def call(conn, sender, path, iface, method, params, inv):
    args = params.unpack()
    if method == "AccessDialog":
        print("GOT AccessDialog handle=%s app=%s parent=%s options=%s" % (args[0], args[1], args[2], ",".join(sorted(args[6]))), flush=True)
        if MODE == "grant":
            inv.return_value(GLib.Variant("(ua{sv})", (0, {"choices": GLib.Variant("a(ss)", [("remember", "true")])})))
        else:
            pending[args[0]] = inv
    else:
        print("GOT Close handle=%s" % args[0], flush=True)
        p = pending.pop(args[0], None)
        if p: p.return_value(GLib.Variant("(ua{sv})", (1, {})))
        inv.return_value(None)
node = Gio.DBusNodeInfo.new_for_xml(XML)
Gio.bus_own_name(Gio.BusType.SESSION, "org.nidara.Shell", Gio.BusNameOwnerFlags.NONE,
    lambda conn, name: conn.register_object("/org/nidara/Shell/Consent", node.interfaces[0], call, None, None), None, None)
GLib.MainLoop().run()
EOF

env -u DBUS_SESSION_BUS_ADDRESS -u WAYLAND_DISPLAY -u DISPLAY \
    XDG_RUNTIME_DIR="$work/runtime" XDG_CONFIG_HOME="$work/config" GIO_USE_VFS=local \
    work="$work" repo="$repo" \
    dbus-run-session -- bash -c '
set -uo pipefail
fail() { echo "FAIL $*"; cat "$work/portal.log" 2>/dev/null; exit 1; }
ok()   { echo "ok   $*"; }
own()  { for _ in $(seq 50); do gdbus call --session -d org.freedesktop.DBus -o /org/freedesktop/DBus \
           -m org.freedesktop.DBus.NameHasOwner "$1" 2>/dev/null | grep -q true && return 0; sleep 0.1; done; return 1; }

dconf write /org/nidara/probe/canary true; sleep 0.3
[ -s "$work/config/dconf/user" ] || fail "dconf canary did not land in the private database — not isolated"

gjs -m "$repo/bin/nidara-portal" > "$work/portal.log" 2>&1 & portal=$!
own org.freedesktop.impl.portal.desktop.nidara || fail "backend did not start"
impl="gdbus call --session --timeout 10 -d org.freedesktop.impl.portal.desktop.nidara -o /org/freedesktop/portal/desktop -m org.freedesktop.impl.portal.Access.AccessDialog"
opts="{\"deny_label\": <\"No\">, \"grant_label\": <\"Yes\">, \"choices\": <[(\"remember\", \"Remember\", @a(ss) [], \"true\")]>}"

# a) grant
python3 -W ignore -u "$work/fakeshell.py" grant > "$work/fake.log" 2>&1 & fake=$!
own org.nidara.Shell || fail "fake shell did not start"
out=$($impl /org/freedesktop/portal/desktop/request/1_9/a org.gnome.clocks wayland:abc "Use camera?" "Clocks" "" "$opts" 2>&1)
[ "$out" = "(uint32 0, {'"'"'choices'"'"': <[('"'"'remember'"'"', '"'"'true'"'"')]>})" ] || fail "a) grant reply: $out"
grep -q "handle=/org/freedesktop/portal/desktop/request/1_9/a app=org.gnome.clocks parent=wayland:abc options=choices,deny_label,grant_label" "$work/fake.log" \
  || fail "a) the shell did not receive the request untouched: $(cat "$work/fake.log")"
ok "a) granted → $out"
kill $fake; wait $fake 2>/dev/null; sleep 0.3

# b) the app closes the request
python3 -W ignore -u "$work/fakeshell.py" hold > "$work/fake.log" 2>&1 & fake=$!
own org.nidara.Shell || fail "fake shell did not start"
( $impl /org/freedesktop/portal/desktop/request/1_9/b org.gnome.clocks "" "Use camera?" "" "" "{}" > "$work/b.out" 2>&1 ) & pending=$!
sleep 1
kill -0 $pending 2>/dev/null || fail "b) AccessDialog returned before anyone answered: $(cat "$work/b.out")"
gdbus call --session -d org.freedesktop.impl.portal.desktop.nidara -o /org/freedesktop/portal/desktop/request/1_9/b \
  -m org.freedesktop.impl.portal.Request.Close >/dev/null 2>&1 || fail "b) Request.Close was not exported at the handle"
wait $pending
out=$(cat "$work/b.out")
[ "$out" = "(uint32 1, @a{sv} {})" ] || fail "b) reply after Close: $out"
grep -q "GOT Close handle=/org/freedesktop/portal/desktop/request/1_9/b" "$work/fake.log" || fail "b) Close did not reach the shell"
ok "b) closed by the app → $out"
kill $fake; wait $fake 2>/dev/null; sleep 0.3

# c) no shell
out=$($impl /org/freedesktop/portal/desktop/request/1_9/c org.gnome.clocks "" "Use camera?" "" "" "{}" 2>&1)
[ "$out" = "(uint32 2, @a{sv} {})" ] || fail "c) reply with no shell: $out"
ok "c) no shell → $out (denied, no hang)"

kill $portal; true
'
