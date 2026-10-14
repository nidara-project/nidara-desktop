#!/usr/bin/env python3
"""Exercise module/exit semantics and the executable-wrapper identity contract."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

repo = Path(__file__).resolve().parents[2]
hosts = Path(sys.argv[1]).resolve()

def run(command, **kwargs):
    return subprocess.run(command, capture_output=True, text=True, timeout=20, **kwargs)

with tempfile.TemporaryDirectory(prefix="nidara-host-check.") as tmp:
    root = Path(tmp)
    modules = {
        "args.js": 'import System from "system"; print(JSON.stringify({argv: ARGV, args: System.programArgs, path: System.programPath}));',
        "dependency.js": 'export const value = "IMPORT_OK";',
        "import.js": 'import {value} from "./dependency.js"; print(value);',
        "async.js": 'print(await Promise.resolve("AWAIT_OK"));',
        "exit.js": 'import {exit} from "system"; exit(23);',
        "throw.js": 'throw new Error("EXPECTED_EXCEPTION");',
        "syntax.js": 'const = ;',
        "missing.js": 'import "./absent.js";',
        "gi.js": 'import Gio from "gi://Gio"; print(Gio.File.new_for_path("/tmp").get_path());',
        "child.js": 'import GLib from "gi://GLib"; import Gio from "gi://Gio"; GLib.unsetenv("LD_PRELOAD"); const p = Gio.Subprocess.new(["/usr/bin/env"], Gio.SubprocessFlags.STDOUT_PIPE); const [ok, text] = p.communicate_utf8(null, null); if (!ok || text.includes("LD_PRELOAD=")) throw Error("preload leaked"); print("CHILD_OK");',
    }
    for name, body in modules.items():
        (root/name).write_text(body)
    for host in ("nidara-shell", "nidara-settings"):
        native = hosts/host
        for module, expected in [("args.js", 0), ("import.js", 0), ("async.js", 0), ("gi.js", 0), ("exit.js", 23), ("throw.js", 1), ("syntax.js", 1), ("missing.js", 1), ("absent.js", 1)]:
            args = ["two words", "--flag", "á"] if module == "args.js" else []
            baseline = run(["gjs", "-m", str(root/module), *args])
            candidate = run([str(native), str(root/module), *args])
            assert baseline.returncode == candidate.returncode == expected, (host, module, candidate)
            if expected == 0:
                assert baseline.stdout == candidate.stdout, (host, module, baseline.stdout, candidate.stdout)
            if module == "exit.js":
                assert not candidate.stderr, candidate.stderr
            if module == "throw.js":
                assert "EXPECTED_EXCEPTION" in candidate.stderr
        assert run([str(native)]).returncode == 2
        child = run([str(native), str(root/"child.js")], env={**os.environ, "LD_PRELOAD": "/usr/lib/libgtk4-layer-shell.so"})
        assert child.returncode == 0 and "CHILD_OK" in child.stdout, child
        print(f"PASS {host}: arguments, imports, GI, async, errors, exits, child environment")

    entry = root/"entry.ts"
    entry.write_text('import GLib from "gi://GLib"; print(JSON.stringify(ARGV)); if (ARGV.includes("--hold")) { print("READY"); new GLib.MainLoop(null, false).run(); }')
    env = {**os.environ, "XDG_RUNTIME_DIR": str(root), "NIDARA_NATIVE_HOST_DIR": str(hosts)}
    for host in ("nidara-shell", "nidara-settings"):
        wrapper = root/f"wrapper-{host}"
        build = run([str(repo/"scripts/bundle.sh"), str(entry), str(wrapper), f"--native-host={host}"])
        assert build.returncode == 0, build
        result = run([str(wrapper), "two words", "--flag", "á"], env=env)
        assert result.returncode == 0 and result.stdout.strip() == '["two words","--flag","á"]', result
        process = subprocess.Popen([str(wrapper), "--hold"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            assert process.stdout.readline().strip() == '["--hold"]'
            assert process.stdout.readline().strip() == "READY"
            proc = Path(f"/proc/{process.pid}")
            assert Path(os.readlink(proc/"exe")).name == host
            assert (proc/"comm").read_text().strip() == host
            # Dev Settings rebuilds both hosts. An identical rebuild must not
            # unlink the shell inode already mapped by a running process.
            before = os.readlink(proc/"exe")
            rebuild = run([str(repo/"lib/nidara-host/build.sh"), str(hosts)])
            assert rebuild.returncode == 0, rebuild
            assert os.readlink(proc/"exe") == before
            process.terminate()
            assert process.wait(timeout=5) == -15
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)
        absent = run([str(wrapper)], env={**env, "NIDARA_NATIVE_HOST_DIR": str(root/"absent")})
        assert absent.returncode == 1 and "Missing native host" in absent.stderr, absent
        print(f"PASS {host}: generated wrapper, executable identity, SIGTERM, absent host")
    legacy = root/"legacy"
    assert run([str(repo/"scripts/bundle.sh"), str(entry), str(legacy)]).returncode == 0
    assert ' -m "$js"' in legacy.read_text() and 'NIDARA_NATIVE_HOST_DIR' not in legacy.read_text()
    assert run([str(legacy), "legacy"], env=env).stdout.strip() == '["legacy"]'
    assert run([str(repo/"scripts/bundle.sh"), str(entry), str(root/"bad"), "--native-host=gjs"]).returncode == 2
    print("PASS legacy GJS wrapper and rejected native role")
print("NATIVE_HOST_OK")
