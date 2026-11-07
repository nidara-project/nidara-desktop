#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
set -euo pipefail
export NK_ICON_CHECK=1 NK_ICON_METRICS=1 NK_CC_DETAILS_CHECK=0 LC_ALL=C.UTF-8
exec "$(dirname "$0")/check-bar-headless.sh"
