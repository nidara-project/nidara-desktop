#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Forced-D5 dropdown composition under private Hyalo. No Config1/AT-SPI/Orca claim."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
ROOT=Path(__file__).resolve().parents[2]
LOG=Path(os.environ['NK_WIDGETS_LOG']).resolve()
BIN=Path(os.environ['NK_WIDGETS_BIN']).resolve()
HYALO=Path(os.environ['HYALO_BIN']).resolve()
if Path(os.environ['XDG_RUNTIME_DIR']).resolve()!=Path(os.environ['NK_WIDGETS_RUN']).resolve()/'runtime':
    raise RuntimeError('private check-headless runtime required')
if LOG==Path('/tmp') or Path('/tmp') in LOG.parents:
    raise RuntimeError('no /tmp evidence')
if any(p.name not in {'cage.log','hyalo.log','check.log'} for p in LOG.iterdir()):
    raise RuntimeError('fresh evidence directory required')
(LOG/'environment.json').write_text(json.dumps({
    'revision':subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True).strip(),
    'probe_sha256':hashlib.sha256(BIN.read_bytes()).hexdigest(),
    'hyalo_sha256':hashlib.sha256(HYALO.read_bytes()).hexdigest(),
    'rendering':'forced opaque D5; same software Hyalo', 'scale':1},indent=2))

def wait(test,label,p):
    end=time.monotonic()+8
    while time.monotonic()<end:
        if test(): return
        if p.poll() is not None: raise RuntimeError(f'exited before {label}: {p.returncode}')
        time.sleep(.01)
    raise RuntimeError(f'setup timeout: {label}')

def run(cancel,fault=''):
    log=LOG/f'{"cancel" if cancel else "select"}-{fault or "baseline"}.log'
    with log.open('w') as output,open(os.environ['HYALO_CONTROL'],'w',buffering=1) as pipe:
        p=subprocess.Popen([str(BIN),*([f'--fault={fault}'] if fault else [])],stdout=output,stderr=output,
                           env={**os.environ,'WAYLAND_DEBUG':'client'})
        try:
            wait(lambda:'PARENT_READY' in log.read_text(),'parent root commit',p)
            pipe.write('key 15\nkey 28\n')
            wait(lambda:'MENU_READY' in log.read_text(),'menu root commit',p)
            pipe.write('key 108\n')
            wait(lambda:'MENU_KEY_HANDLED 65364' in log.read_text(),'Down dispatch',p)
            pipe.write(f'key {1 if cancel else 28}\n')
            p.wait(timeout=8)
            text=log.read_text()
            if p.returncode or 'MENU_FINISHED' not in text:
                raise RuntimeError('menu lifecycle did not finish')
            result=re.search(r'RESULT index=(\d+) caption=(.*?) selected=(.*?) focus=(true|false) expanded=false commit=(\d+)',text)
            if not result or ('MENU_CANCEL_HANDLED' if cancel else 'MENU_ACTIVATION_HANDLED') not in text:
                raise RuntimeError('missing independent handled/parent commit barriers')
            assert 'get_popup(' in text,'dropdown did not use xdg_popup'
            assert re.search(r'xdg_popup[^\n]*\.grab\(',text),'dropdown lacked a physical input grab'
            assert result[4]=='true','focus did not return to the trigger'
            expected=0 if cancel else 1
            assert int(result[1])==expected, 'cancel committed a focused value' if cancel else 'selection did not reach the parent model'
            expected_label='English' if cancel else 'Español'
            assert result[2]==result[3]==expected_label,'caption and Selection model disagree'
            return {'setup_complete':True,'index':int(result[1]),'caption':result[2], 'parent_commit':int(result[5])}
        finally:
            if p.poll() is None:
                p.terminate();p.wait(timeout=5)

result={}
for cancel,fault,expected in [(False,'ignore-selection','selection did not reach the parent model'),
                             (True,'commit-focus-on-cancel','cancel committed a focused value')]:
    name='cancel' if cancel else 'select'
    result[name]=run(cancel)
    try: run(cancel,fault)
    except AssertionError as error:
        if str(error)!=expected: raise
        result[fault]={'setup_complete':True,'caught':str(error)}
    else: raise AssertionError(f'{fault} escaped its own assertion')
(LOG/'oracles.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result))
