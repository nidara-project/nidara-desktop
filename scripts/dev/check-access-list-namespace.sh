#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Root-owned policy fixtures in a private user/mount/PID/network namespace.
# No sudo or host /etc writes. Build nidara-access tests and Hyalo before running.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=${OUT:-$repo/target/ipc-policy/access-list-$(date +%s-%N)}
mkdir -p "$(dirname "$out")"
mkdir -m 700 "$out"
out=$(realpath "$out")
mkdir -m 700 "$out/fixture"
cp -L /usr/bin/python3 "$out/fixture/python"
cp -L /usr/bin/python3 "$out/fixture/session"
cp -L /usr/bin/python3 "$out/fixture/settings"
cp -L /usr/bin/python3 "$out/fixture/legacy-settings"
test_bin=${ACCESS_TEST_BIN:-$(find "$repo/session/target/debug/deps" -maxdepth 1 -type f -executable -name 'nidara_access-*' -printf '%T@ %p\n' | sort -nr | head -1 | cut -d' ' -f2-)}
[ -n "$test_bin" ] || { echo 'Build nidara-access tests first' >&2; exit 1; }
# The existing executable must be inside this checkout, bound read-only below.
case "$test_bin" in "$repo/"*) test_bin="/repo/${test_bin#"$repo/"}";; *) exit 2;; esac
cat > "$out/driver.py" <<'PY'
import os
from pathlib import Path
import stat
import subprocess
import sys

helper = '/repo/scripts/dev/register-ipc-access.py'
repo = '/work/dev-repo'
os.umask(0o077)
Path(repo).mkdir()
command = ['/usr/bin/python3', helper, '--repo', repo, '--uid', '0']
subprocess.run(command, check=True)
config = Path('/etc/nidara/access.d/dev-0.conf')
m = config.stat()
assert m.st_uid == 0 and stat.S_IMODE(m.st_mode) == 0o644
assert stat.S_IMODE(config.parent.stat().st_mode) == 0o755, 'installer umask made policy unreadable'
text = config.read_text()
assert '\t0\t/work/dev-repo/lib/nidara-host/build/nidara-shell' in text
assert '\t0\t/work/dev-repo/toolkit/target/release/nk-settings' in text
assert 'legacy-settings\t0\t/work/dev-repo/lib/nidara-host/build/nidara-settings' in text
assert '\t0\t/work/dev-repo/session/target/release/nidara-sessiond' in text
subprocess.run(command, check=True)
assert config.read_text() == text, 'writer is not idempotent'
config.unlink()
config.symlink_to('/work/not-root-config')
assert subprocess.run(command, capture_output=True).returncode != 0, 'writer accepted target symlink'
config.unlink()
Path('/etc/nidara/access.d').rename('/etc/nidara/saved.d')
Path('/etc/nidara/access.d').symlink_to('/etc/nidara/saved.d')
assert subprocess.run(command, capture_output=True).returncode != 0, 'writer accepted directory symlink'
Path('/etc/nidara/access.d').unlink()
Path('/etc/nidara/saved.d').rename('/etc/nidara/access.d')
print('PASS: real UID0 writer is atomic/idempotent; root-owned mode0644; refuses file/directory symlinks')
config.write_text('legacy-shell\t0\t/work/fixture/python\nsession\t0\t/work/fixture/session\nsettings\t0\t/work/fixture/settings\nlegacy-settings\t0\t/work/fixture/legacy-settings\nsession\t0\t/repo/session/target/debug/nidara-sessiond\n')
config.chmod(0o644)
subprocess.run([sys.argv[1], '--ignored', '--exact', 'access_list::tests::namespace_root_fixtures', '--nocapture'], check=True)
# Also exercise configuration revocation on the same kernel-pinned peer.
subprocess.run(['/repo/hyalo/target/debug/nidara-hyalo', '--version'], check=True)
subprocess.run(['/repo/scripts/dev/check-ipc-policy-headless.sh'], env={**os.environ, 'OUT': '/work/headless'}, check=True)
PY
# A new synthetic root: host files under /usr are read-only; /etc is created here.
bwrap --unshare-user --unshare-pid --unshare-net --die-with-parent --uid 0 --gid 0 \
    --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib /lib64 \
    --ro-bind /etc/passwd /etc/passwd --ro-bind /etc/group /etc/group --ro-bind /etc/fonts /etc/fonts \
    --ro-bind "$repo" /repo --bind "$out" /work --tmpfs /tmp --proc /proc --dev /dev \
    --file 3 /nidara-access-fixture --setenv HOME /work --chdir /work \
    /usr/bin/python3 /work/driver.py "$test_bin" 3</dev/null >"$out/check.log" 2>&1
cat "$out/check.log"
printf 'Evidence: %s\n' "$out"
