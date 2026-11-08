#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
set -euo pipefail
export NK_WIDGETS_CHECK="../../toolkit/shell/nc_check.py"
exec "$(dirname "$0")/check-notifications-headless.sh"
