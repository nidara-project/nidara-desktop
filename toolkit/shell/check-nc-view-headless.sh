#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# The notification centre on nk-view (#1048): its cards, calendar, groups, keyboard and clears.
set -euo pipefail
export NK_WIDGETS_CHECK="../../toolkit/shell/nc_view_check.py"
exec "$(dirname "$0")/check-notifications-headless.sh"
