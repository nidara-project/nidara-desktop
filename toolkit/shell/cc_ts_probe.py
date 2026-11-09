#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Bundle the unchanged TS readers, with declaration-only widget metadata.
No TS widget/service is started. Run --build before the graphical harness.
"""
import json,re,subprocess,sys
from pathlib import Path
repo=Path(__file__).resolve().parents[2]
out=Path(sys.argv[2]).resolve();out.mkdir(parents=True,exist_ok=True)
assert sys.argv[1]=='--build'
meta={};defaults={};fixed=[]
for source in sorted((repo/'ui/shell/widgets').glob('*.ts')):
    text=source.read_text()
    ident=re.search(r'\bid:\s*"([a-z_]+)"',text)
    size=re.search(r'defaultSize:\s*WidgetSize\.([A-Z_]+)',text)
    sizes=re.search(r'supportedSizes:\s*\[([^]]+)\]',text)
    if not (ident and size and sizes):continue
    ident=list(re.finditer(r'\bid:\s*"([a-z_]+)"',text[:size.start()]))[-1][1]
    meta[ident]={'defaultSize':size[1],'sizes':re.findall(r'WidgetSize\.([A-Z_]+)',sizes[1])}
    defaults[ident]={'bar':bool(re.search(r'defaultInBar:\s*true',text)),'cc':not bool(re.search(r'defaultInCc:\s*false',text))}
    if re.search(r'ccFixed:\s*true',text):fixed.append(ident)
size_values={'SINGLE':'1x1','WIDE':'2x1','TALL':'1x2','SQUARE':'2x2','FULL_WIDTH':'4x1'}
for value in meta.values():
    value['defaultSize']=size_values[value['defaultSize']];value['sizes']=[size_values[v] for v in value['sizes']]
index=(repo/'ui/shell/widgets/index.ts').read_text();curated=index[index.index('export const CC_DEFAULT_LAYOUT'):]
layout=[{'id':ident,'size':size_values[size]} for ident,size in re.findall(r'id:\s*"([a-z_]+)",\s*size:\s*WidgetSize\.([A-Z_]+)',curated)]
assert len(meta)==15 and len(layout)==10 and "screenshot" in meta,(meta,layout)
(out/'metadata.ts').write_text('export const WIDGET_META='+json.dumps(meta)+';\nexport const CC_DEFAULT_LAYOUT='+json.dumps(layout)+';\nexport const DEFAULT_PLACEMENT='+json.dumps(defaults)+';\nexport const CC_FIXED=new Set('+json.dumps(fixed)+');\nexport const DEFAULT_BAR_MODE={};export const BAR_PRESENCE=new Set();export const BAR_ORDER=[];\n')
(out/'sizes.ts').write_text('export const WidgetSize='+json.dumps(size_values)+';\n')
(out/'configFile.ts').write_text((repo/'ui/shell/core/configFile.ts').read_text())
cc=(repo/'ui/shell/surfaces/control-center/CCLayoutManager.ts').read_text().replace('"../../core/configFile"','"./configFile"').replace('"../../common/widget-kit"','"./sizes"').replace('"../../widgets/index"','"./metadata"')
(out/'CCLayoutManager.ts').write_text(cc)
wc=(repo/'ui/shell/core/WidgetConfig.ts').read_text().replace('"../widgets/index"','"./metadata"')
(out/'WidgetConfig.ts').write_text(wc)
(out/'probe.ts').write_text('import cc from "./CCLayoutManager";import widgets from "./WidgetConfig";import {WIDGET_META} from "./metadata";print(JSON.stringify({layout:cc.layout,placement:Object.fromEntries(Object.keys(WIDGET_META).map(id=>[id,widgets.get(id)]))}));\n')
subprocess.run(['esbuild',str(out/'probe.ts'),'--bundle','--format=esm','--platform=neutral','--target=es2020','--external:gi://*','--outfile='+str(out/'probe.js')],check=True)
