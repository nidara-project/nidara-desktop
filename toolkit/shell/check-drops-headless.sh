#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# Real Nautilus, our dock/daemon, private bus and settings. No installed-session effects.
set -euo pipefail
export NK_DOCK_DROP_CHECK=1 LC_ALL=C.UTF-8
export RUST_LOG="${RUST_LOG:-warn},nidara_hyalo::protocols::drag_feedback=debug,nidara_hyalo::state=debug"
exec "$(dirname "$0")/check-dock-headless.sh"
