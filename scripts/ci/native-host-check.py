#!/usr/bin/env python3
"""Exercise module/exit semantics and the executable-wrapper identity contract."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

repo = Path(__file__).resolve().parents[2]
hosts = Path(sys.argv[1]).resolve()
# The one list of runners (lib/nidara-host/hosts): bundles first, then bin/ helpers.
names = [l.strip() for l in (repo/"lib/nidara-host/hosts").read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")]
# A helper is a bin/ script the kernel starts through its runner; bin/nidara-settings,
# -greeter and -lock are bash launchers of bundles that carry the same name.
first_line = lambda n: (repo/"bin"/n).read_text().splitlines()[0] if (repo/"bin"/n).is_file() else ""
helpers = [n for n in names if first_line(n).startswith("#!/usr/lib/nidara/")]
bundles = [n for n in names if n not in helpers]
assert sorted(p.name for p in hosts.glob("nidara-*")) == sorted(names), "build.sh must produce exactly the listed hosts"

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
    cases = [("args.js", 0), ("import.js", 0), ("async.js", 0), ("gi.js", 0), ("exit.js", 23), ("throw.js", 1), ("syntax.js", 1), ("missing.js", 1), ("absent.js", 1)]
    argsFor = lambda module: ["two words", "--flag", "á"] if module == "args.js" else []
    baselines = {m: run(["gjs", "-m", str(root/m), *argsFor(m)]) for m, _ in cases}
    for host in names:
        native = hosts/host
        for module, expected in cases:
            args = argsFor(module)
            baseline = baselines[module]
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
    for host in bundles:
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
            assert (proc/"comm").read_text().strip() == host[:15], (host, (proc/"comm").read_text())
            # Dev Settings rebuilds both hosts. An identical rebuild must not
            # unlink the shell inode already mapped by a running process.
            if host == bundles[0]:
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
    # bin/ helpers name their runner in the shebang, so the kernel starts the
    # host and /proc/PID/exe and comm name the helper, never "gjs".
    for host in helpers:
        source = (repo/"bin"/host).read_text()
        shebang = source.splitlines()[0]
        assert shebang == f"#!/usr/lib/nidara/{host}", (host, shebang)
        script = root/host
        script.write_text(f"#!{hosts/host}\n" + 'import GLib from "gi://GLib"; import System from "system"; print(JSON.stringify([ARGV, System.programPath])); print("READY"); new GLib.MainLoop(null, false).run();')
        script.chmod(0o755)
        process = subprocess.Popen([str(script), "two words", "á"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            assert process.stdout.readline().strip() == json.dumps([["two words", "á"], str(script)], ensure_ascii=False, separators=(",", ":"))
            assert process.stdout.readline().strip() == "READY"
            proc = Path(f"/proc/{process.pid}")
            assert Path(os.readlink(proc/"exe")).name == host
            assert (proc/"comm").read_text().strip() == host[:15]
            process.terminate()
            assert process.wait(timeout=5) == -15
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)
        print(f"PASS {host}: shebang, arguments, executable identity")
    stray = [p.name for p in (repo/"bin").iterdir() if p.is_file() and "gjs" in p.read_bytes()[:80].decode("latin-1").splitlines()[0]]
    assert not stray, f"bin/ scripts still started by the gjs console: {stray} — add them to lib/nidara-host/hosts"
    legacy = root/"legacy"
    assert run([str(repo/"scripts/bundle.sh"), str(entry), str(legacy)]).returncode == 0
    assert ' -m "$js"' in legacy.read_text() and 'NIDARA_NATIVE_HOST_DIR' not in legacy.read_text()
    assert run([str(legacy), "legacy"], env=env).stdout.strip() == '["legacy"]'
    assert run([str(repo/"scripts/bundle.sh"), str(entry), str(root/"bad"), "--native-host=gjs"]).returncode == 2
    print("PASS legacy GJS wrapper and rejected native role")
print("NATIVE_HOST_OK")
