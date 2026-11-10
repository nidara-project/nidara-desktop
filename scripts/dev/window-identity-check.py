#!/usr/bin/python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""#998: real Applications1 wire, private XDG/bus, coherent synthetic H1.

Filesystem/process evidence has independent Rust fixtures. This walk validates
published answers, token lifetime/races, parent inheritance and both page domains.
It does not contact the installed session or claim physical desktop acceptance.
"""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import time

import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

HERE = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location("a3", HERE.with_name("applications3-check.py"))
a3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a3)


def setup(out, env):
    a3.setup(out, env)
    directory = out / "data/applications"
    for name, fields in [("chatgpt.desktop", ""), ("steam-game.desktop", "StartupWMClass=steam_app_440\n")]:
        (directory / name).write_text(f"[Desktop Entry]\nType=Application\nName={name}\nExec=/usr/bin/true\n{fields}")


def inside(binary, out):
    out = Path(out)
    h = a3.Hyalo(os.environ["HYALO_SOCKET"])
    h.early = False
    services = a3.a2.Services(out)
    daemon = None
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

    def call(method, sig=None, args=()):
        return bus.call_sync(a3.NAME, a3.PATH, a3.IFACE, method, GLib.Variant(sig, args) if sig else None,
                             None, Gio.DBusCallFlags.NO_AUTO_START, 10000, None).unpack()

    def wait(predicate, label):
        end = time.monotonic() + 15
        while time.monotonic() < end:
            try:
                result = predicate()
                if result:
                    return result
            except GLib.Error:
                pass
            time.sleep(.02)
        raise AssertionError(label)

    def snapshot():
        epoch, _, state = call("GetSnapshot")
        tokens = []
        for domain, continuation in [("Apps", "AppsNext"), ("WindowMatches", "WindowMatchesNext")]:
            state[domain] = list(state[domain])
            token = state[continuation]
            if token:
                tokens.append(token)
            while token:
                page, token = call("ReadSnapshotPage", "(ts)", (epoch, token))
                state[domain].extend(page)
        if tokens:
            call("CloseSnapshot", "(ts)", (epoch, tokens[0]))
        return epoch, state

    def matches():
        return {v["WindowId"]: v for v in snapshot()[1]["WindowMatches"]}

    def answer(window, app, kind):
        def ready():
            values = matches()
            return values.get(window) if values.get(window, {}).get("DesktopId") == app and values[window]["MatchKind"] == kind else None
        value = wait(ready, f"{window}: {app} / {kind}")
        epoch, state = snapshot()
        assert call("ResolveWindow", "(tst)", (epoch, state["HyaloEpoch"], window))[0] == value
        if app: assert value["Narrowing"] and value["Narrowing"][-1]["CandidateCount"] == 1
        return value

    try:
        with (out / "daemon.log").open("a") as log:
            daemon = subprocess.Popen([binary, "--applications"], stdout=log, stderr=log)
        wait(lambda: snapshot()[1]["MatchingAvailable"], "matching ready")
        h.windows = [dict(id=1, app_id="Chatgpt", focused=False), dict(id=2, app_id="", parent=1, focused=False),
                     dict(id=3, app_id="unknown-app", focused=False), dict(id=4, app_id="", steam_app=440, focused=False)]
        h.window_list()
        answer(1, "chatgpt.desktop", "case-insensitive-app-id")
        answer(2, "chatgpt.desktop", "parent")
        answer(3, "", "unknown")
        answer(4, "steam-game.desktop", "sandbox")
        subprocess.run(["gsettings","set","org.nidara.ai","allow-computer-control","true"],check=True)
        time.sleep(.15)
        epoch, state = snapshot()
        app = next(a for a in state["Apps"] if a["DesktopId"] == "Files.desktop")
        call("Launch", "(tsta{sv})", (epoch, "Files.desktop", app["Generation"], {"ActivationToken": GLib.Variant("s", "identity-private-token")}))
        wait(lambda: h.seen, "token observed")
        launch = h.seen[-1]
        h.emit(dict(event="launch_outcome", launch=launch, outcome="window", window=3, honoured=True))
        answer(3, "Files.desktop", "activation-token")
        # A second window arrives before the coalesced windows list, after launch completion.
        h.emit(dict(event="launch_outcome", launch=launch, outcome="window", window=5, honoured=False))
        h.windows.append(dict(id=5, app_id="unknown-second", focused=False))
        h.windows[2]["app_id"] = "changed-name"
        h.window_list()
        answer(3, "Files.desktop", "activation-token")
        answer(5, "Files.desktop", "activation-token")
        # Both domains share one snapshot session; every published record equals ResolveWindow.
        h.windows.extend(dict(id=n, app_id="Files", focused=False) for n in range(10, 310))
        h.window_list()
        wait(lambda: len(matches()) == 305, "matching pages")
        epoch, state = snapshot()
        for value in state["WindowMatches"]:
            assert call("ResolveWindow", "(tst)", (epoch, state["HyaloEpoch"], value["WindowId"]))[0] == value
        h.windows = [w for w in h.windows if w["id"] != 3]
        h.window_list()
        wait(lambda: 3 not in matches(), "window close retires link")
        previous = snapshot()[1]["HyaloEpoch"]
        h.emit(dict(event="anything"), skip=1)
        wait(lambda: snapshot()[1]["MatchingAvailable"] and snapshot()[1]["HyaloEpoch"] != previous, "fresh H1 connection")
        answer(5, "", "unknown")
        print("PASS #998: shared published/ResolveWindow answers (305 windows), case folding, Steam, parent, unknown, multiple token windows, outcome-before-list, close and epoch reset. Synthetic H1; no installed/visual claim.")
    finally:
        if daemon:
            daemon.terminate()
            daemon.wait(timeout=5)
        h.close()
        services.close()


if __name__ == "__main__":
    if sys.argv[1] == "--inside":
        inside(sys.argv[2], sys.argv[3])
    else:
        sys.exit(a3.a2.a1.outer(sys.argv[1], driver=str(HERE), setup=setup))
