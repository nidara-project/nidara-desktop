#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Private literal-argv cliphist/wl-copy stand-ins; never access the real clipboard."""
import base64,json,os,sys
from pathlib import Path
state=Path(os.environ['NK_CC_CLIP_STATE']);log=Path(os.environ['NK_CC_CLIP_LOG'])
name=Path(sys.argv[0]).name
if name=='wl-copy':Path(os.environ['NK_CC_COPIED']).write_bytes(sys.stdin.buffer.read());raise SystemExit(0)
entries=json.loads(state.read_text());method=sys.argv[1];data=sys.stdin.buffer.read() if method in ['decode','delete'] else b''
with log.open('a') as file:file.write(json.dumps([method,data.decode('ascii')])+'\n')
if method=='list':
 for e in entries:sys.stdout.buffer.write(e['id'].encode()+b'\t'+base64.b64decode(e['preview'])+b'\n')
elif method=='decode':
 e=next(e for e in entries if e['id']==data.decode().split('\t')[0]);sys.stdout.buffer.write(base64.b64decode(e['raw']))
elif method=='delete':state.write_text(json.dumps([e for e in entries if e['id']!=data.decode().split('\t')[0]]))
elif method=='wipe':state.write_text('[]')
else:raise SystemExit(2)
