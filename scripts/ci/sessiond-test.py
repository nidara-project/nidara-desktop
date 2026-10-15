#!/usr/bin/env python3
"""Real D-Bus integration, including the shell's unmodified notifd client API.

Run: python3 scripts/ci/sessiond-test.py session/target/debug/nidara-sessiond \
       --client /tmp/notifd-client.js
The outer invocation creates a private bus AND disposable cache. Never runs the
new server on the user's bus and never reads their notification history.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import time


def main(args):
    from gi.repository import Gio, GLib

    public = "org.freedesktop.Notifications"
    private = "org.nidara.Notifications1"
    public_path = "/org/freedesktop/Notifications"
    private_path = "/org/nidara/Notifications"
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    context = GLib.MainContext.default()
    closed, invoked, notified, resolved = [], [], [], []
    daemon = None
    clients = []
    log = tempfile.TemporaryFile(mode="w+")
    cache = Path(os.environ["XDG_CACHE_HOME"]) / "nidara/notifd"
    cache.mkdir(parents=True, mode=0o700)
    # An actual old serialize() fixture, not output produced by the new server.
    old = dict(id=71, app_name="old GJS server", app_icon="mail", summary="before the switch",
               body="preserved body", expire_timeout=50, time=1700000000,
               hints={"urgency": 2, "image_path": "/old/avatar.png", "resident": True},
               actions=[{"id": "open", "label": "Read"}])
    (cache / "state.json").write_text(json.dumps({"version": 1, "notifications": [old]}))

    def check(ok, label):
        if not ok:
            raise AssertionError(f"FAIL: {label}")
        print(f"PASS: {label}", flush=True)

    def pump():
        while context.pending():
            context.iteration(False)

    def wait(predicate, label, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pump()
            if predicate():
                return
            time.sleep(.01)
        raise AssertionError(f"FAIL: {label} (timeout)")

    def call(method, values=None, signature=None, priv=False):
        return bus.call_sync("org.nidara.Session" if priv else public,
                             private_path if priv else public_path,
                             private if priv else public, method,
                             GLib.Variant(signature, values) if signature else None,
                             None, Gio.DBusCallFlags.NO_AUTO_START, 3000, None).unpack()

    def listing():
        return json.loads(call("List", priv=True)[0])

    def notify(replace=0, summary="summary", hints=None, timeout=-1, actions=None):
        return call("Notify", ("probe", replace, "icon", summary, "body", actions or [], hints or {}, timeout),
                    "(susssasa{sv}i)")[0]

    def owns():
        return bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                             "NameHasOwner", GLib.Variant("(s)", (public,)), None,
                             Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]

    def start():
        nonlocal daemon
        daemon = subprocess.Popen([args.binary], stdout=log, stderr=log)
        wait(lambda: owns() or daemon.poll() is not None, "daemon ready")
        check(daemon.poll() is None, "daemon starts")
        wait(lambda: bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                                  "NameHasOwner", GLib.Variant("(s)", ("org.nidara.Session",)), None,
                                  Gio.DBusCallFlags.NONE, 3000, None).unpack()[0], "private interface ready")

    def stop():
        daemon.terminate()
        check(daemon.wait(timeout=4) == 0, "daemon shuts down cleanly and flushes")
        wait(lambda: not owns(), "public name released")

    for iface, path, signal, dest in [(public, public_path, "NotificationClosed", closed),
            (public, public_path, "ActionInvoked", invoked),
            (private, private_path, "Notified", notified), (private, private_path, "Resolved", resolved)]:
        bus.signal_subscribe(None, iface, signal, path, None, Gio.DBusSignalFlags.NONE,
                             lambda _c, _s, _p, _i, _n, params, dest=dest: dest.append(params.unpack()))
    # Match rules must be installed before any test traffic.
    bus.flush_sync(None)

    class Client:
        def __init__(self):
            self.err = tempfile.TemporaryFile(mode="w+")
            self.proc = subprocess.Popen(["gjs", "-m", args.client], stdin=subprocess.PIPE,
                                         stdout=subprocess.PIPE, stderr=self.err)
            self.buffer = b""
            clients.append(self)

        def snapshot(self, **command):
            self.proc.stdin.write((json.dumps(command) + "\n").encode())
            self.proc.stdin.flush()
            deadline = time.monotonic() + 4
            while b"\n" not in self.buffer:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([self.proc.stdout], [], [], max(0, remaining))[0]:
                    raise AssertionError("FAIL: GJS client response (timeout)")
                chunk = os.read(self.proc.stdout.fileno(), 65536)
                if not chunk:
                    self.err.seek(0)
                    raise AssertionError("FAIL: GJS client exited: " + self.err.read())
                self.buffer += chunk
            line, self.buffer = self.buffer.split(b"\n", 1)
            return json.loads(line)

        def close(self):
            if self.proc.poll() is None:
                self.proc.stdin.close()
                self.proc.wait(timeout=4)

    try:
        # Without the daemon: exactly one warning, empty NC, no bus ownership.
        c = Client() if args.client else None
        if c:
            wait(lambda: (c.err.seek(0) or True) and "unavailable" in c.err.read(), "absent daemon warning")
            check(c.snapshot()["notifications"] == [] and not owns(), "absent daemon: empty client, no fallback server")
            c.snapshot(); c.snapshot()
            c.err.seek(0)
            check(c.err.read().count("unavailable") == 1, "absent daemon warns only once")
        start()
        rival = subprocess.run([args.binary], stdout=log, stderr=log, timeout=4)
        check(rival.returncode != 0 and owns(), "second daemon cannot replace or queue behind the owner")
        check(listing() == [old], "old Notification.serialize history survives unchanged")
        time.sleep(.08)
        check(listing() == [old], "restored history does not rearm sender expiry")
        if c:
            wait(lambda: c.snapshot()["notifications"] == [old], "client reconnects to newly started daemon")
            check(c.snapshot()["notified"] == [], "reconnect hydration emits no banner callbacks")
        check(call("GetCapabilities")[0] == ["actions", "body", "body-markup", "body-images", "icon-static", "persistence"], "capabilities match the promise")
        check(call("GetServerInformation") == ("nidara", "nidara-project", "1.0", "1.2"), "server information unchanged")
        call("Dismiss", (71,), "(u)", priv=True)
        result = subprocess.run(["notify-send", "--print-id", "--expire-time=0", "from notify-send", "body"],
                                text=True, capture_output=True, timeout=5, check=True)
        ident = int(result.stdout)
        check(len(listing()) == 1 and listing()[0]["id"] == ident, "notify-send creates exactly one List entry")
        if c:
            wait(lambda: any(n["id"] == ident for n in c.snapshot()["notified"]), "live arrival reaches banner subscribers")
        replacement = notify(replace=ident, summary="replacement")
        check(replacement == ident and len(listing()) == 1 and listing()[0]["summary"] == "replacement", "replaces_id replaces the live entry")
        wait(lambda: any(n[0] == ident and n[1] for n in notified), "Notified replacement flag")
        call("CloseNotification", (ident,), "(u)")
        wait(lambda: (ident, 3) in closed and (ident, 3) in resolved, "CloseNotification emits NotificationClosed and Resolved reason 3")
        check(not listing(), "closed notification removed")
        check(notify(replace=ident) == ident, "replaces_id adopts an already resolved id")
        call("Dismiss", (ident,), "(u)", priv=True)
        wait(lambda: (ident, 2) in closed and (ident, 2) in resolved, "Dismiss resolves with reason 2")
        count = len(closed)
        call("Dismiss", (ident,), "(u)", priv=True)
        pump()
        check(len(closed) == count, "dismiss gone notification is a no-op")
        upper = notify(replace=0x7fffffff)
        fresh = notify(replace=0xffffffff)
        check(upper == 0x7fffffff and 0 < fresh < upper, "adopted id ceiling cannot overflow the sequence")
        for n in listing():
            call("Dismiss", (n["id"],), "(u)", priv=True)
        expiring = notify(timeout=80)
        wait(lambda: (expiring, 1) in closed, "positive sender expiry resolves with reason 1")
        timed = notify(timeout=200)
        notify(replace=timed, timeout=0)
        time.sleep(.25)
        check(any(n["id"] == timed for n in listing()), "replacement cancels old expiry; zero never expires")
        nonresident = notify(actions=["open", "Read", "unpaired"])
        call("InvokeAction", (nonresident, "open"), "(us)", priv=True)
        wait(lambda: (nonresident, "open") in invoked and (nonresident, 3) in closed, "nonresident action emits ActionInvoked then closes")
        resident = notify(hints={"resident": GLib.Variant("b", True)}, actions=["open", "Read"])
        if c:
            wait(lambda: any(n["id"] == resident for n in c.snapshot()["notifications"]), "client sees resident")
            c.snapshot(method="invoke", id=resident, action="open")
        else:
            call("InvokeAction", (resident, "open"), "(us)", priv=True)
        wait(lambda: (resident, "open") in invoked, "resident invokes action")
        check(any(n["id"] == resident for n in listing()) and (resident, 3) not in closed, "resident remains live after action")
        # A padded RGB row and a short final row, matching GdkPixbuf's accepted input.
        raw = bytes([220, 64, 200, 0, 10, 20, 30])
        image = GLib.Variant("(iiibiiay)", (1, 2, 4, False, 8, 3, raw))
        image_id = notify(hints={"image-data": image, "image_data": image, "icon_data": image,
                                 "urgency": GLib.Variant("x", 2), "complex": GLib.Variant("as", ["drop"])} )
        entry = next(n for n in listing() if n["id"] == image_id)
        image_path = Path(entry["hints"]["image-path"])
        check(image_path.name == hashlib.sha256(raw).hexdigest()[:32] + ".png" and image_path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n", "image-data decoded to content-addressed PNG")
        notify(hints={"image-data": image})
        check(len(list((cache / "images").iterdir())) == 1, "identical image data is deduplicated")
        check(entry["hints"]["urgency"] == 2 and set(entry["hints"]) == {"image-path", "urgency"}, "scalar hints only; int64 urgency and deprecated image hints")
        check((cache.stat().st_mode & 0o777) == 0o700 and ((cache / "images").stat().st_mode & 0o777) == 0o700, "private cache and image directories are 0700")
        for i in range(151):
            notify(hints={"image-data": GLib.Variant("(iiibiiay)", (1, 1, 3, False, 8, 3, bytes([i, 0, 0])))})
        check(len(list((cache / "images").iterdir())) == 150, "image cache capped at 150 files")
        malformed = notify(hints={"image-data": GLib.Variant("(iiibiiay)", (1, 2, 4, False, 8, 3, b"x")),
                                  "image_path": GLib.Variant("s", "/legacy.png")})
        check(next(n for n in listing() if n["id"] == malformed)["hints"] == {"image_path": "/legacy.png"}, "malformed pixels preserve legacy image path without crashing")
        transient = notify(hints={"transient": GLib.Variant("i", 1)})
        check(any(n["id"] == transient for n in listing()), "transient is live before restart")
        expected = [n for n in listing() if not n["hints"].get("transient")]
        # Kill only the GJS client, keep notifying, then reconnect a fresh client.
        if c:
            c.proc.kill(); c.proc.wait(timeout=4)
            for i in range(20):
                notify(summary=f"shell down {i}")
            expected = [n for n in listing() if not n["hints"].get("transient")]
            c = Client()
            wait(lambda: len(c.snapshot()["notifications"]) == len(listing()), "shell restart recovers all arrivals")
            check(c.snapshot()["notified"] == [], "shell restart has no banner flood")
        stop()
        check(json.loads((cache / "state.json").read_text()) == {"version": 1, "notifications": expected}, "store retains exact serialize shape and excludes transient")
        if c:
            wait(lambda: c.snapshot()["notifications"] == [], "client clears on daemon loss")
        start()
        check(listing() == expected, "daemon restart keeps persisted history")
        if c:
            wait(lambda: c.snapshot()["notifications"] == expected, "same client rehydrates after daemon restart")
            check(c.snapshot()["notified"] == [], "daemon restart produces no banners")
            check(c.snapshot()["history"] == expected, "already-open NC refreshes through its unchanged roster subscription")
            last = expected[-1]["id"]
            c.snapshot(method="dismiss", id=last)
            wait(lambda: all(n["id"] != last for n in listing()), "Notification.dismiss reaches daemon")
        stop()
        print("sessiond integration: all checks passed", flush=True)
    finally:
        for client in clients:
            client.close()
        if daemon and daemon.poll() is None:
            daemon.terminate()
            daemon.wait(timeout=4)
        log.seek(0)
        print(log.read(), file=sys.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=lambda p: str(Path(p).resolve()))
    parser.add_argument("--client", type=lambda p: str(Path(p).resolve()))
    parser.add_argument("--private", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not args.private:
        with tempfile.TemporaryDirectory(prefix="nidara-sessiond-test-") as cache:
            command = ["dbus-run-session", "--", sys.executable, __file__, args.binary, "--private"]
            if args.client:
                command += ["--client", args.client]
            sys.exit(subprocess.run(command, env={**os.environ, "XDG_CACHE_HOME": cache, "GIO_USE_VFS": "local"}, timeout=60).returncode)
    try:
        main(args)
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        sys.exit(1)
