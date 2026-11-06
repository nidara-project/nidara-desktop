#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# Private B2.2 exercise of the bar surface and its service contracts.
set -euo pipefail
export NK_CC_DETAILS_CHECK=1 NK_CC_ONLY=1 LC_ALL=C.UTF-8
exec "$(dirname "$0")/check-bar-headless.sh"
