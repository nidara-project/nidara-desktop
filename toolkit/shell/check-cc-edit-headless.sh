#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# Private B2.3 edit/widget walk; no installed session or CI workflow changes.
set -euo pipefail
export NK_WIDGETS_CHECK="../../toolkit/shell/cc_edit_check.py"
export LC_ALL=C.UTF-8
: "${NK_WIDGETS_LOG:?provide an evidence directory}"
export NK_CC_TS_PROBE="$NK_WIDGETS_LOG/ts-probe/probe.js"
python3 "$(dirname "$0")/cc_ts_probe.py" --build "$NK_WIDGETS_LOG/ts-probe"
exec "$(dirname "$0")/check-notifications-headless.sh"
