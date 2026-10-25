# SPDX-License-Identifier: LGPL-3.0-or-later
"""Identity, not translated titles or toolkit-decorated application names."""
def by_pid(applications, pid):
    return next((app for app in applications if app.get_process_id() == pid), None)

def describe(applications):
    return [{'pid': app.get_process_id(), 'name': app.get_name()} for app in applications]
