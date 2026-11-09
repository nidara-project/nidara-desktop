#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Discriminating layout source controls. Run before any graphical check."""
from pathlib import Path
import json,subprocess,sys
source=Path(__file__).with_name('src')/'cclayout.rs'
text=source.read_text();out=Path(sys.argv[1]).resolve();out.mkdir(parents=True,exist_ok=True)
mutants={
 'baseline':None,
 'no-swap':('if conflicts.len() == 1','if false && conflicts.len() == 1'),
 'reverse-gravity':('if *y > conflict.y {','if *y < conflict.y {'),
 'lift-above-gap':('while y > freed.y &&','while y > 0 &&'),
 'lose-bar-default':('or_insert((default_bar(id), false))','or_insert((false, false))'),
}
report={}
for name,change in mutants.items():
    code=text
    if change:
        assert change[0] in code,name
        code=code.replace(*change)
    path=out/(name+'.rs');path.write_text(code)
    driver=out/(name+'-driver.rs');driver.write_text('#[path='+json.dumps(str(path))+'] mod layout;\n')
    binary=out/name
    built=subprocess.run(['rustc','--edition=2024','--test','-C','debuginfo=0',str(driver),'-o',str(binary)],capture_output=True,text=True)
    assert built.returncode==0,built.stderr
    ran=subprocess.run([str(binary)],capture_output=True,text=True)
    (out/(name+'.log')).write_text(ran.stdout+ran.stderr)
    report[name]={'passed':ran.returncode==0}
    assert (ran.returncode==0)==(name=='baseline'),(name,ran.stdout)
    print(name,'PASS' if ran.returncode==0 else 'CAUGHT',flush=True)
(out/'report.json').write_text(json.dumps(report,indent=2))
