#!/bin/sh
# Hyalo, in a window, inside a headless cage — nothing appears on the live desktop, and the
# GPU is the real one — with a client inside Hyalo; a screenshot of cage's output after N s.
#
#   hyalo/scripts/headless-shot.sh <out.png> <seconds> <client command>
#
# HYALO_ACTIONS='echo "click X Y" >$HYALO_CONTROL; sleep 1' runs before the screenshot
# (verbs in compositor/src/control.rs). HYALO_BIN overrides the binary (default: release).
# HYALO_LOG gets Hyalo's own log (default: next to the screenshot).
set -eu
out=$(realpath -m "$1"); secs=$2; shift 2
here=$(dirname "$(realpath "$0")")
bin=${HYALO_BIN:-$here/../target/release/nidara-hyalo}
bin=$(realpath "$bin")
log=${HYALO_LOG:-${out%.png}.log}
inner=$(mktemp)
fifo=$(mktemp -u); mkfifo "$fifo"
cat > "$inner" <<INNER
#!/bin/sh
export HYALO_CONTROL="$fifo"
# A config of its own, so a user's ~/.config/nidara/hyalo.toml does not leak into a test.
export HYALO_CONFIG="\${HYALO_CONFIG:-/dev/null}"
"$bin" --winit -c "$*" >"$log" 2>&1 &
pid=\$!
sleep $secs
[ -n "\${HYALO_ACTIONS:-}" ] && sh -c "\$HYALO_ACTIONS"
grim "$out"
kill \$pid
INNER
chmod +x "$inner"
env -u DISPLAY WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 cage -- "$inner" 2>&1 \
  | grep -v -E 'EGL|GLES|extensions' || true
rm -f "$inner" "$fifo"
