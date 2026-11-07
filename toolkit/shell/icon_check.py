#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Private real-theme measurements, with committed-frame rather than request-only times."""
import json, os, subprocess, time
from pathlib import Path

def setup(run):
    fixture = json.loads(Path(os.environ['NK_ICON_OWNER_FIXTURE']).read_text())
    subprocess.run(['gsettings','set','org.gnome.desktop.interface','icon-theme',fixture['theme']],check=True)
    subprocess.run(['gsettings','set','org.nidara.dock','layout',fixture['layout']],check=True)
    subprocess.run(['gsettings','set','org.nidara.dock','layout-version','1'],check=True)
    icons = Path.home()/'.local/share/icons'
    if icons.exists(): (run/'data/icons').symlink_to(icons)

def catalogue(data):
    # Preserve real precedence while all catalogue state stays in the private run.
    for root in [Path('/usr/share/applications'),Path.home()/'.local/share/applications']:
        if root.exists():
            for source in root.glob('*.desktop'):
                (data/'applications'/source.name).write_bytes(source.read_bytes())

def icons_visible(picture, frame):
    """Reject blank glass in any icon rectangle; geometry comes from the renderer."""
    import gi
    gi.require_version('GdkPixbuf', '2.0')
    from gi.repository import GdkPixbuf
    pix = GdkPixbuf.Pixbuf.new_from_file(str(picture))
    data, stride, channels = pix.get_pixels(), pix.get_rowstride(), pix.get_n_channels()
    sx, sy = pix.get_width()/frame['size'][0], pix.get_height()/frame['size'][1]
    for x,y,w,h in frame['rectangles']:
        colors = [sum(data[yy*stride+xx*channels:yy*stride+xx*channels+3]) for yy in range(max(0,int(y*sy)),min(pix.get_height(),int((y+h)*sy)),2) for xx in range(max(0,int(x*sx)),min(pix.get_width(),int((x+w)*sx)),2)]
        if not colors or max(colors)-min(colors) < 90:
            return False
    return bool(frame['rectangles'])

def run(ctx):
    until,log,ipc = ctx['until'],ctx['LOG'],ctx['ipc']
    current_log = log/'shell.log'
    def events():
        return [json.loads(line.split('ICON_METRIC ',1)[1]) for line in current_log.read_text().splitlines(keepends=True) if line.endswith('\n') and 'ICON_METRIC ' in line]
    def ready(surface, after=0, instance=None):
        frames=[e for e in events() if e['event']=='frame' and e.get('surface')==surface and e['us']>=after and (instance is None or e.get('instance')==instance)]
        return frames and frames[-1]['wanted']>=2 and frames[-1]['ready']==frames[-1]['wanted'] and frames[-1].get('visible',True) and frames
    def dock_result():
        until('real catalogue',lambda:any(e['event']=='catalogue' for e in events()),timeout=60)
        frames=until('all visible dock icons committed',lambda:ready('dock'),timeout=60)
        first=frames[0];last=next(e for e in frames if e['wanted']==frames[-1]['wanted'] and e['ready']==e['wanted'] and e.get('visible',True))
        visible=next((e for e in frames if e.get('visible',True)),last)
        return {'first_frame_ready':first['ready'],'first_frame_wanted':first['wanted'],'first_visible_ready':visible['ready'],'first_visible_wanted':visible['wanted'],'last_frame_wanted':last['wanted'],'mapped_to_last_icon_ms':(last['us']-first['us'])/1000}
    def apps_result(label):
        before=len([e for e in events() if e['event']=='request']);start=time.monotonic();start_us=time.monotonic_ns()//1000
        ctx['shell1']('ToggleSurface',ctx['GLib'].Variant('(sb)',('app-grid',True)),quiet=False)
        opened=until('Apps opening measurement',lambda:next((e for e in reversed(events()) if e['event']=='apps-open' and e['us']>=start_us),None))
        instance=opened['instance']
        frames=until('all visible Apps icons committed',lambda:ready('apps',instance=instance),timeout=60)
        first=frames[0];last=next(e for e in frames if e['ready']==e['wanted'] and e.get('visible',True))
        visible=next((e for e in frames if e.get('visible',True)),last)
        # Include prefetch jobs so zero means no round trip at all on reopen.
        time.sleep(.3)
        count=len([e for e in events() if e['event']=='request'])-before
        if 'rectangles' in last: until('complete Apps buffer frame callback',lambda:any(e['event']=='frame-done' and e.get('surface')=='apps' and e.get('instance')==instance and e['commit']>=last['commit'] for e in events()),timeout=20)
        picture = log / (label + '.png')
        def painted():
            # Capture Cage directly: an IPC screenshot which times out can
            # otherwise overwrite the fallback PNG asynchronously later.
            subprocess.run(['grim', str(picture)], check=True, timeout=10,
                           env={**os.environ, 'WAYLAND_DISPLAY':'wayland-0'})
            return icons_visible(picture, last)
        if 'rectangles' in last:
            until('visible pixels in every Apps icon rectangle',painted,timeout=20)
        else:
            ctx['shot'](picture)  # historical baseline instrumentation
        pixels_ms=(time.monotonic()-start)*1000
        count=len([e for e in events() if e['event']=='request'])-before
        ctx['shell1']('ToggleSurface',ctx['GLib'].Variant('(sb)',('app-grid',False)),quiet=False)
        until('Apps closes',lambda:not [l for l in ipc('layers').get('ok',{}).get('layers',[]) if l.get('namespace')=='nidara-apps'])
        return {'get_icon_requests':count,'first_frame_ready':first['ready'],'visible':first['wanted'],'first_visible_ready':visible['ready'],'first_visible_wanted':visible['wanted'],'open_to_last_icon_ms':(last['us']-opened['us'])/1000,'open_to_confirmed_pixels_ms':pixels_ms,'all_icon_rectangles_visible':True if 'rectangles' in last else None,'wall_seconds':time.monotonic()-start}
    cold_dock=dock_result()
    if os.environ.get('NK_ICON_REFRESH_PROBE') == '1':
        # Controlled overlap with a catalogue refresh, private copies only.
        next((ctx['RUN']/'apps/applications').glob('*.desktop')).touch()
        time.sleep(.25)
    cold_apps=apps_result('apps-cold');warm_apps=apps_result('apps-warm')
    ctx['shot'](log/'dock-ready.png')
    def daemon_events():
        return [json.loads(line.split('ICON_DAEMON_METRIC ',1)[1]) for line in (log/'sessiond.log').read_text().splitlines() if 'ICON_DAEMON_METRIC ' in line]
    if os.environ.get('NK_ICON_RESTART_QUIET') == '1':
        # Compare daemon-warm restarts at the same refresh phase. Faster Apps
        # otherwise restarts the shell earlier in this scenario's background scan.
        trigger_us=time.monotonic_ns()//1000
        next((ctx['RUN']/'apps/applications').glob('*.desktop')).touch()
        def refreshed():
            return any(json.loads(line.split('ICON_DAEMON_DETAIL ',1)[1]).get('stage')=='catalogue-refresh' and json.loads(line.split('ICON_DAEMON_DETAIL ',1)[1])['start_us']>=trigger_us for line in (log/'sessiond.log').read_text().splitlines(keepends=True) if line.endswith('\n') and 'ICON_DAEMON_DETAIL ' in line)
        until('explicit private refresh completes before daemon-warm restart',refreshed,timeout=30)
    ctx['shell'].terminate();ctx['shell'].wait(timeout=10)
    daemon_before=len(daemon_events())
    until('old dock unmapped',lambda:not ctx['docks']())
    current_log=log/'shell-warm.log'
    ctx['start']('shell-warm',[ctx['SHELL'],'--bar'])
    warm_dock=dock_result()
    reads=daemon_events()[daemon_before:]
    warm_dock['daemon_hits']=sum(e['hit'] for e in reads)
    warm_dock['daemon_misses']=sum(not e['hit'] for e in reads)
    report={'theme':json.loads(Path(os.environ['NK_ICON_OWNER_FIXTURE']).read_text())['theme'],'dock_cold':cold_dock,'apps_cold':cold_apps,'apps_reopen':warm_apps,'dock_daemon_warm_shell_new':warm_dock}
    (log/'icon-metrics.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2),flush=True)

    if os.environ.get('NK_ICON_ASSERT') == '1':
        assert warm_apps['get_icon_requests'] == 0, report
        assert warm_dock['daemon_hits'] > 0 and warm_dock['daemon_misses'] == 0, report
        for batch in [cold_dock, cold_apps, warm_apps, warm_dock]:
            assert batch['first_visible_ready'] == batch['first_visible_wanted'], report
