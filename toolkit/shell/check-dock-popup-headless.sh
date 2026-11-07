#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# The shared popup-presence/re-entry assertions with a real bar, on private services.
set -euo pipefail
export NK_DOCK_POPUP_ONLY=1 LC_ALL=C.UTF-8
exec "$(dirname "$0")/check-bar-headless.sh"
