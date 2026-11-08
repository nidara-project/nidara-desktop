#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Real mutation controls for B3.1's pure stack, without modifying the worktree.
Run only when graphical checks have stopped. OUT is a disposable evidence/target
folder; the source copies, compiler logs and mutant verdicts are retained there.
"""
import json
import os
from pathlib import Path
import subprocess

REPO = Path(__file__).resolve().parents[2]
OUT = Path(os.environ.get('OUT', REPO / 'toolkit/target/notification-model-controls')).resolve()
OUT.mkdir(parents=True, exist_ok=True)
source = (REPO / 'toolkit/shell/src/notifications.rs').read_text()
crate = OUT / 'crate'
(crate / 'src').mkdir(parents=True, exist_ok=True)
(crate / 'Cargo.toml').write_text('''[package]
name="notification-model-controls"
version="0.0.0"
edition="2024"
[dependencies]
serde={version="1",features=["derive"]}
serde_json="1"
[profile.dev]
debug=0
incremental=false
[profile.test]
debug=0
incremental=false
''')
MUTANTS = [
    ('critical-retired-by-global-age', 'self.entries.remove(retire);', 'self.entries.pop_front();', 'saturation_preserves_critical_until_every_slot_is_critical'),
    ('wrong-retired-card', 'self.entries.remove(retire);', 'self.entries.pop_back();', 'cap_replaces_in_place_and_retires_old_action_identity'),
    ('stale-action-survives', 'old.content = old.content.saturating_add(1);', 'old.content = old.content;', 'cap_replaces_in_place_and_retires_old_action_identity'),
    ('critical-expires', 'if self.critical() || self.expire_timeout == 0', 'if self.expire_timeout == 0', 'local_timeout_hover_and_critical_are_independent_of_daemon_dismissal'),
    ('hover-does-not-pause', 'e.deadline = if on {\n            None', 'e.deadline = if on {\n            Some(now)', 'local_timeout_hover_and_critical_are_independent_of_daemon_dismissal'),
    ('DND-lets-normal-through', '!notice.critical()', 'false', 'suppression_critical_exception_and_lock'),
    ('lock-keeps-cards', '!gates.locked &&', 'true &&', 'suppression_critical_exception_and_lock'),
    ('game-grace-missing', 'pub const GAME_GRACE_MS: u64 = 3000;', 'pub const GAME_GRACE_MS: u64 = 0;', 'game_exit_grace_does_not_replay_suppressed_history'),
    ('suppressed-replacement-leaves-old-critical', 'return self.resolve(notice.id) || changed;', 'return changed;', 'suppressed_replacement_retires_the_old_critical_card'),
    ('markup-leaks-into-label', 'stripped.push_str(&rest[..open]);', 'stripped.push_str(&rest[..open+1]);', 'markup_is_plain_text_entities_decode_once_and_unicode_is_preserved'),
]
report = {}
def run(label, text, test=None):
    (crate / 'src/lib.rs').write_text(text)
    command = ['cargo','test','--offline','--manifest-path',str(crate/'Cargo.toml')]
    if test: command += [test]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=120,
                            env={**os.environ,'CARGO_TARGET_DIR':str(OUT/'target'),'CARGO_BUILD_JOBS':'2'})
    (OUT/(label+'.log')).write_text(result.stdout)
    if test:
        assert result.returncode != 0 and test+' ... FAILED' in result.stdout, 'control failed for another reason: '+label
    else:
        assert result.returncode == 0, result.stdout
    report[label] = 'CAUGHT' if test else 'PASS'
    print(label, report[label], flush=True)
run('baseline',source)
for label,before,after,test in MUTANTS:
    assert before in source, 'mutation anchor absent: '+label
    run(label,source.replace(before,after,1),test)
run('restored',source)
(OUT/'report.json').write_text(json.dumps(report,indent=2))
