#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# The NC pilot on nk-view (#1048), with NK_NC_VIEW=1 in the shell's environment.
set -euo pipefail
export NK_NC_VIEW=1
export NK_WIDGETS_CHECK="../../toolkit/shell/nc_view_check.py"
exec "$(dirname "$0")/check-notifications-headless.sh"
