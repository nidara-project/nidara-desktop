# SPDX-License-Identifier: GPL-3.0-or-later
"""Storage scenarios imported by sessiond-network-test.py on its PRIVATE buses."""
import hashlib
import json
import pwd
import os


def exercise(net, ctrl, info, state, bus, ui, questions, restart, h):
    v, check, wait = h['v'], h['check'], h['wait']
    DEV, AP = h['DEV'], h['AP']
    def probe(uuid='storage-fixture'):
        return json.loads(ctrl('StorageProbe','(s)',(uuid,))[0])
    def policy(p):
        return p['settings']['802-11-wireless-security'].get('psk-flags',0)
    def stable(p):
        return {k:p[k] for k in ('settings','system','user')}
    def setup(mode, enterprise=False):
        for key in ('nmFailAt','nmDenyAt','ssWriteFailAt','ssDeleteFailAt','concurrentAt','appliedErrorAt'):
            state(key,[])
        state('callbacks',False)
        ctrl('StorageFixture','(sb)',(mode,enterprise))
        return probe()
    def change(target, all_users=True, values=None):
        if values is None:
            return net('SetSecretStorage','(ssb)',('storage-fixture',target,all_users))
        return net('SetSecretStorageWithSecrets','(ssba{sa{sv}})',('storage-fixture',target,all_users,values))
    def reconcile():
        return net('ReconcileSecretStorage','(s)',('storage-fixture',))
    def failure(fn, name=None):
        try:
            fn()
        except h['GLib'].Error as e:
            if name:
                check(name in str(e),'storage refuses '+name)
            return
        raise AssertionError('storage accepted injected failure: '+str(name))
    def at(key, counter, offset):
        index=info()[counter]+offset
        state(key,[index])
        return index
    def fingerprint(value):
        return hashlib.sha256(value.encode()).hexdigest()
    def locations(p,target,expected=1):
        check(len(p['system'])==(expected if target=='system' else 0) and len(p['user'])==(expected if target=='user' else 0),'only '+target+' retains the persistent secret')
        for digest in list(p['system'].values())+list(p['user'].values()):
            check(digest==fingerprint('fixture-psk'),'credential survives storage migration')

    # Every new-connection storage mode uses the same real agent interaction.
    state('newNeedsSecrets',True);state('newFinalState',2)
    for mode,all_users in [('user',True),('system',False),('ask',True),('default',True)]:
        state('ssid','StorageCreation-'+mode)
        before=len(questions);completion=[]
        method='ConnectDefault' if mode=='default' else 'Connect'
        args=v('(oos)',(DEV,AP,'')) if mode=='default' else v('(oossb)',(DEV,AP,'',mode,all_users))
        def done(c,res):
            try:
                c.call_finish(res);completion.append(True)
            except h['GLib'].Error as e:
                completion.append(str(e))
        bus.call(h['NET'],h['NETPATH'],h['IFACE'],method,args,None,h['Gio'].DBusCallFlags.NONE,20000,None,done)
        wait(lambda:len(questions)>before,'storage creation question')
        request=json.loads(questions[-1][1]);uuid=request['uuid']
        net('SubmitSecrets','(ta{sa{sv}})',(questions[-1][0],{'802-11-wireless-security':{'psk':v('s','creation-secret')}}),c=ui)
        wait(lambda:bool(completion),'storage creation completes')
        check(completion==[True],'Connect in '+mode+' mode')
        expected='user' if mode=='default' else mode
        check(policy(probe(uuid))=={'user':1,'system':0,'ask':2}[expected],'creation selected flags '+expected)
        wait(lambda:len(probe(uuid)['user'])==(1 if expected=='user' else 0),'creation persistence settled')
        p=probe(uuid)
        check(len(p['system'])==(1 if expected=='system' else 0),'NM persistence matches creation mode')
        acl=p['settings']['connection'].get('permissions',[])
        check(acl==([] if all_users else ['user:'+pwd.getpwuid(os.getuid()).pw_name+':']),'creation permissions are independent of storage')
        wait(lambda:any(row['uuid']==uuid and row['allUsers']==all_users and row['secretStorage']['802-11-wireless-security.psk']['mode']==expected for row in json.loads(net('Snapshot')[2])['profiles']),'storage metadata announced')
        check('creation-secret' not in net('Snapshot')[2],'Snapshot never exposes the stored value')
    state('newNeedsSecrets',False);state('newFinalState',4);state('ssid','Test')

    # Consistent profiles need no repair write or extra authorization before a change.
    for mode in ('system','user','ask'):
        before=setup(mode)
        old_updates=info()['nmUpdates']
        reconcile()
        after=probe()
        repair_updates=info()['nmUpdates']-old_updates
        unchanged=after==before
        old_updates=info()['nmUpdates']
        change('ask' if mode!='ask' else 'user', values=(
            {'802-11-wireless-security':{'psk':v('s','fixture-psk')}} if mode=='ask' else None))
        change_updates=info()['nmUpdates']-old_updates
        check(unchanged and repair_updates==0 and change_updates==1,
              mode+' consistent reconciliation preserves VersionId and mode change uses one NM update'
              +' (repair='+str(repair_updates)+', change='+str(change_updates)+')')

    # All directed transitions, including ask -> persistence without existing input.
    for source in ('user','system','ask'):
        for target in ('user','system','ask'):
            if source==target:
                continue
            before=setup(source)
            supplied=None
            if source=='ask' and target!='ask':
                old=info()['nmUpdates']
                failure(lambda:change(target),'NeedsSecrets')
                check(info()['nmUpdates']==old and stable(probe())==stable(before),'NeedsSecrets refuses without mutation')
                supplied={'802-11-wireless-security':{'psk':v('s','fixture-psk')}}
            change(target,False,supplied)
            p=probe();locations(p,target)
            check(p['settings']['connection']['permissions']==['user:'+pwd.getpwuid(os.getuid()).pw_name+':'],'migration private permissions')
    before=setup('user')
    old=info()['nmUpdates']
    failure(lambda:change('bad'),'Invalid')
    check(info()['nmUpdates']==old,'invalid mode has no mutation')

    # Optional EAP secrets are not reclassified as ask; binary fields are handled by
    # the service but the fixture's two mandatory secrets exercise partial failures.
    setup('system',True)
    change('user')
    p=probe()
    check(p['settings']['802-1x']['pin-flags']==4 and len(p['user'])==2 and not p['system'],'optional EAP flag preserved and mandatory keys migrated')
    state('callbacks',True)
    change('system')
    change('user')
    check(len(probe()['user'])==2 and not probe()['system'],'NM callback during Update2 completes without holding SS queue')

    setup('system',True)
    ctrl('StorageBinary')
    change('user')
    p=probe()
    check(p['user']['802-1x.password-raw']==hashlib.sha256(bytes([0,255,1])).hexdigest(),'binary EAP secret persists without text conversion')
    change('system')
    check(probe()['system']['802-1x.password-raw']==hashlib.sha256(bytes([0,255,1])).hexdigest() and not probe()['user'],'binary EAP secret returns to NM')

    setup('user')
    ctrl('StorageWep')
    change('system')
    p=probe()
    check(p['system']=={'802-11-wireless-security.wep-key0':fingerprint('abcde'),'802-11-wireless-security.wep-key2':fingerprint('vwxyz')} and not p['user'],'all saved WEP slots move with shared flags, empty slots are optional')

    for mode in ('user','system','ask'):
        setup(mode)
        ctrl('StorageCopies')
        reconcile();locations(probe(),mode)
        once=stable(probe());reconcile()
        check(stable(probe())==once,'duplicate recovery honors '+mode+' flags idempotently')
    setup('user')
    change('system')
    before_writes=info()['ssWriteCalls']
    ctrl('LateStorageSave')
    wait(lambda:info().get('lateResult') is not None,'late callback after storage mode change')
    check(info()['lateResult'] and not probe()['user'] and info()['ssWriteCalls']==before_writes,'late old user save cannot recreate system-mode keyring copy')
    change('ask')
    ctrl('LateStorageSave')
    wait(lambda:info().get('lateResult') is not None,'late callback after ask')
    check(not probe()['system'] and not probe()['user'],'late callback respects committed ask intent')

    # Partial destination failure: some SS keys were written, source NM stays intact.
    before=setup('system',True)
    failed_write=at('ssWriteFailAt','ssWriteCalls',2)
    failure(lambda:change('user'))
    check(stable(probe())==stable(before),'partial destination refusal rolls back without losing source')
    check(info()['ssWriteCalls']==failed_write,'destination partial-write control reached')

    # NM policy denial and an ordinary update failure both leave original policy/data.
    for fault,name in [('nmDenyAt','Denied'),('nmFailAt',None)]:
        before=setup('user')
        at(fault,'nmUpdates',1)
        failure(lambda:change('system'),name)
        check(stable(probe())==stable(before),'NM refusal keeps profile, permissions and keyring source')
    before=setup('system')
    at('nmFailAt','nmUpdates',1)
    failure(lambda:change('user'))
    check(stable(probe())==stable(before),'NM cleanup refusal removes only new SS destination')

    setup('system')
    at('concurrentAt','nmUpdates',1)
    failure(lambda:change('user'),'Incomplete')
    p=probe()
    check(p['settings']['connection']['id']=='external-writer-name' and p['system'] and p['user'],'CAS conflict preserves external edit and both safe copies')
    state('concurrentAt',[])
    reconcile()
    check(probe()['settings']['connection']['id']=='external-writer-name' and not probe()['user'],'recovery respects external profile revision')

    setup('system')
    at('appliedErrorAt','nmUpdates',1)
    failure(lambda:change('user'),'Incomplete')
    p=probe()
    check(p['settings']['connection']['id']=='external-after-apply' and policy(p)==1 and p['user'],'uncertain applied update cannot roll back a later external edit')
    state('appliedErrorAt',[])
    reconcile()
    check(probe()['settings']['connection']['id']=='external-after-apply' and not probe()['system'],'uncertain update recovers using persisted policy')

    # Failure while erasing source after a verified destination: restore source first.
    before=setup('user',True)
    at('ssDeleteFailAt','ssDeleteCalls',2)
    failure(lambda:change('system'))
    check(stable(probe())==stable(before),'partial source cleanup rolls back to original user storage')

    # Rollback can fail too. Keep the verified NM destination, report both locations,
    # and use flags after a process restart to reconcile without any new secret store.
    setup('user',True)
    at('ssDeleteFailAt','ssDeleteCalls',1)
    at('nmFailAt','nmUpdates',2)
    failure(lambda:change('system'),'Incomplete')
    partial=probe()
    check(len(partial['system'])==2 and len(partial['user'])==2,'failed rollback retains durable destination and reports duplicate')
    state('nmFailAt',[]);state('ssDeleteFailAt',[])
    if restart:
        restart()
    reconcile()
    check(len(probe()['system'])==2 and not probe()['user'],'recovery follows NM flags after interruption')
    once=stable(probe());reconcile()
    check(stable(probe())==once,'reconciliation is idempotent')

    # Ask commits an erasure intent. A partial delete is explicit and recoverable;
    # no third store or restoration of an unwanted password is introduced.
    setup('user',True)
    at('ssDeleteFailAt','ssDeleteCalls',2)
    failure(lambda:change('ask'),'Incomplete')
    p=probe()
    check(p['settings']['802-1x']['password-flags']==2 and len(p['user'])==1 and not p['system'],'ask commit reports remaining copy after partial cleanup')
    state('ssDeleteFailAt',[])
    reconcile();once=stable(probe());reconcile()
    check(not probe()['user'] and not probe()['system'] and stable(probe())==once,'ask reconciliation completes erasure idempotently')
    setup('system')
    before=stable(probe());at('nmFailAt','nmUpdates',1)
    failure(lambda:change('ask'))
    check(stable(probe())==before,'failed ask commit leaves original system secret')
    for key in ('nmFailAt','nmDenyAt','ssWriteFailAt','ssDeleteFailAt','concurrentAt','appliedErrorAt'):
        state(key,[])
    check(True,'all secret storage scenarios used private fake peers')
