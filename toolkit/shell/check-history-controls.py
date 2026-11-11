#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Mutation controls on source copies; no production files or installed session change."""
import json,os,re,shutil,subprocess
from pathlib import Path
REPO=Path(__file__).resolve().parents[2]
OUT=Path(os.environ['OUT']).resolve();OUT.mkdir(parents=True,exist_ok=True)
TARGET=Path(os.environ['CARGO_TARGET_DIR']).resolve()
(OUT/'runtime').mkdir(exist_ok=True)
history=OUT/'history';(history/'src').mkdir(parents=True,exist_ok=True)
(history/'Cargo.toml').write_text('''[package]
name="notification-history-controls"
version="0.0.0"
edition="2024"
[workspace]
[dependencies]
serde={version="1",features=["derive"]}
serde_json="1"
sha2="0.10"
png="0.18"
zbus={version="5",default-features=false,features=["tokio"]}
glib={version="0.22",features=["v2_66"]}
''')
(history/'src/lib.rs').write_text('mod model;\nmod store;\n')
for name in ['model','store']:(history/f'src/{name}.rs').write_text((REPO/f'session/daemon/src/{name}.rs').read_text())
shell=OUT/'shell';(shell/'src').mkdir(parents=True,exist_ok=True)
for src in (REPO/'toolkit/shell/src').glob('*'):
    if src.is_file():shutil.copyfile(src,shell/'src'/src.name)
    elif src.is_dir():shutil.copytree(src,shell/'src'/src.name,dirs_exist_ok=True)
# Preserve dependency identities and all real production code; only the package root moves.
manifest=(REPO/'toolkit/shell/Cargo.toml').read_text()
for field,value in {'version':'"0.1.0"','edition':'"2024"','rust-version':'"1.90"','license':'"LGPL-3.0-or-later"','publish':'false'}.items():manifest=re.sub(r'^'+re.escape(field)+r'\.workspace = true$',field+' = '+value,manifest,flags=re.M)
manifest=re.sub(r'path = "([^"]+)"',lambda m:'path = '+json.dumps(str((REPO/'toolkit/shell'/m[1]).resolve())),manifest)
(shell/'Cargo.toml').write_text(manifest+'\n[workspace]\n')
p=shell/'src/icon_memory.rs';p.write_text(p.read_text().replace('"../../../session/daemon/src/applications/fallback.svg"',json.dumps(str(REPO/'session/daemon/src/applications/fallback.svg'))))
# The centre's view tests read the exported tokens; the copy's own path has none.
os.environ.setdefault('NK_SETTINGS_DATA',str(REPO/'build/settings-data'))
REPORT={}
def run(label,crate,test,fail=False):
    command=['cargo','test','--offline','--manifest-path',str(crate/'Cargo.toml'),'--lib',test]
    p=subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=180,env={**os.environ,'CARGO_TARGET_DIR':str(TARGET),'CARGO_INCREMENTAL':'0','CARGO_PROFILE_DEV_DEBUG':'0','CARGO_PROFILE_TEST_DEBUG':'0','CARGO_BUILD_JOBS':'2','TMPDIR':str(OUT/'runtime')})
    (OUT/(label+'.log')).write_text(p.stdout)
    if fail:assert p.returncode!=0 and test.split('::')[-1]+' ... FAILED' in p.stdout,(label,p.stdout[-2000:])
    else:assert p.returncode==0,(label,p.stdout[-2000:])
    REPORT[label]='CAUGHT' if fail else 'PASS';print(label,REPORT[label],flush=True)
run('history-baseline',history,'tests')
run('viewport-baseline',shell,'nc')
mutations=[
 ('startup-without-preservation',history,'store.rs','self\n            .preserve_input(&mut health)','Ok::<(), io::Error>(())','store::tests::startup_preserves_corrupt_input_and_can_continue_with_live_notifications'),
 ('recovery-loses-live-model',history,'store.rs','self.compact(live)?;','self.compact(&[])?;','store::tests::refused_writes_recover_the_live_model_without_resurrecting_removed_records'),
 ('legacy-import-skipped-after-outage',history,'store.rs','needs_publication = true;\n                    live =','needs_publication = false;\n                    live =','store::tests::failed_legacy_import_must_publish_all_live_records_before_creating_a_journal'),
 ('clear-repeated',shell,'nc_view.rs','        if self.clearing.is_some() {\n            return None;\n        }\n','','nc_view::tests::clear_all_sends_the_cards_off_one_after_another_then_clears_once'),
 ('seven-days',history,'model.rs','7 * 86400','30 * 86400','model::tests::retention_seven_days_critical_and_protected_today'),
 ('safety-ceiling',history,'model.rs','saturating_sub(2000)','saturating_sub(2001)','model::tests::retention_seven_days_critical_and_protected_today'),
 ('critical-age-out',history,'model.rs','!= Some(2)','!= Some(255)','model::tests::retention_seven_days_critical_and_protected_today'),
 ('today-discarded',history,'model.rs','n.time < today','n.time <= now','model::tests::retention_seven_days_critical_and_protected_today'),
 ('full-rewrite',history,'store.rs','// Amortized compaction,','self.compact(live)?;\n        // Amortized compaction,','store::tests::journal_append_is_one_bounded_operation_without_rewriting_history'),
 ('bulk-per-row',history,'store.rs','// Amortized compaction,','if let Change::Remove{ids}=change && ids.len()>1 {for id in ids {self.append(&Change::Remove{ids:vec![*id]},live)?;}return Ok(());}\n        // Amortized compaction,','store::tests::journal_append_is_one_bounded_operation_without_rewriting_history'),
 ('layout-all-history',shell,'nc_view.rs','let near = |y: f64, h: f64| y + h >= lo && y <= hi;','let near = |_: f64, _: f64| true;','nc_view::tests::a_long_open_group_builds_only_the_rows_near_the_window'),
 ('expand-all-groups',shell,'nc_view.rs','let open = self.groups_open.contains(key);','let open = true;','nc_view::tests::each_notification_or_group_is_its_own_card_and_the_calendar_another'),
 ('calendar-no-leap-day',shell,'nc.rs','1..=31','1..=28','nc::tests::calendar_leap_year_and_relative_minutes'),
]
selected=set(filter(None,os.environ.get('CONTROL_FILTER','').split(',')))
for label,crate,file,before,after,test in mutations:
    if selected and label not in selected:continue
    p=crate/'src'/file;original=p.read_text();assert before in original,label
    p.write_text(original.replace(before,after,1))
    try:run(label,crate,test,True)
    finally:p.write_text(original)
run('history-restored',history,'tests');run('viewport-restored',shell,'nc')
(OUT/'report.json').write_text(json.dumps(REPORT,indent=2)+'\n')
