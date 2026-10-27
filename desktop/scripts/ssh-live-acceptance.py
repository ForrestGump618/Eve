"""Opt-in real SSH acceptance. Credentials are read privately, never reported.

python desktop/scripts/ssh-live-acceptance.py --credentials PATH
Only creates/removes an unpredictable acceptance directory under remote HOME.
"""
from __future__ import annotations
import argparse
import asyncio
import json
import statistics
import sys
import tempfile
import time
import uuid
import hashlib
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from omicslab.config import Settings
from omicslab.workspace import Workspace
from omicslab.ssh.connections import get_connection_service
from omicslab.execution.ssh_backend import SSHExecutionBackend
from omicslab.server.routes_harness import execute_backend


async def main(credentials: Path):
    secret = json.loads(credentials.read_text(encoding='utf-8'))
    private = Path(tempfile.mkdtemp(prefix='suwen-live-ssh-'))
    settings = Settings(home=private, workspace=private/'local-workspace')
    settings.workspace.mkdir()
    (settings.workspace/'marker.txt').write_text('LOCAL_MUST_NOT_BE_READ', encoding='utf-8')
    service = get_connection_service(settings)
    profile = service.add_profile(name='Live acceptance', auth='password', **secret)
    other = service.add_profile(name='Second isolated profile', auth='password', **secret)
    directory = '.suwen-acceptance-' + uuid.uuid4().hex
    report = {'kind':'real SSH transport and remote files, shell, Python and skill; no mock backend',
              'checks':[], 'latencies_ms':[], 'started_at':time.strftime('%Y-%m-%dT%H:%M:%S%z')}
    backend = None
    remote_root = None
    async def check(name, action, assertion):
        start=time.perf_counter()
        try:
            result=await action()
            assert assertion(result), 'Unexpected actual result'
            report['checks'].append({'name':name,'passed':True})
            return result
        except Exception as exc:
            # Exception text may contain user-provided tool code; do not include
            # credentials, profile exports or environment dumps in evidence.
            report['checks'].append({'name':name,'passed':False,'error_type':type(exc).__name__,'message':str(exc)[:1000]})
            raise
        finally:
            report['latencies_ms'].append(round((time.perf_counter()-start)*1000,2))
    try:
        result=await check('password authentication',lambda:asyncio.to_thread(service.test_connection,profile['id']),lambda r:r['ok'])
        home=await asyncio.to_thread(service.manager.exec,profile['id'],'pwd',record=False)
        assert home['status']=='ok'
        remote_root=home['stdout'].strip().rstrip('/')+'/'+directory
        await asyncio.to_thread(service.manager.mkdir,profile['id'],remote_root,parents=False)
        workspace=Workspace('ws_acceptance','SSH acceptance',backend='ssh',remote={'profile_id':profile['id'],'root':remote_root})
        backend=SSHExecutionBackend(workspace,settings=settings,connections=service)
        await backend.start()
        await check('create and read-back verify',lambda:execute_backend(backend,'write_file',{'path':'marker.txt','content':'REMOTE_ACCEPTANCE\n'}),lambda r:r['verified'])
        original=await check('remote read never reads local twin',lambda:execute_backend(backend,'read_file',{'path':'marker.txt'}),lambda r:r['content']=='REMOTE_ACCEPTANCE\n')
        await check('remote text search',lambda:execute_backend(backend,'search_files',{'query':'REMOTE_ACCEPTANCE'}),lambda r:len(r['matches'])==1)
        try:
            await execute_backend(backend,'write_file',{'path':'marker.txt','content':'SHOULD_NOT_WRITE','expectedSha256':'0'*64})
        except ValueError:
            report['checks'].append({'name':'stale hash rejects overwrite','passed':True})
        else:raise AssertionError('Stale overwrite accepted')
        await check('hash guarded edit',lambda:execute_backend(backend,'write_file',{'path':'marker.txt','content':'REMOTE_UPDATED\n','expectedSha256':original['sha256']}),lambda r:r['verified'])
        await check('scoped shell working directory',lambda:execute_backend(backend,'run_shell',{'command':'pwd'}),lambda r:r['stdout'].strip()==remote_root)
        await check('remote Python worker',lambda:backend.execute_python('import socket; print("REMOTE_PYTHON", socket.gethostname())'),lambda r:r['ok'] and 'REMOTE_PYTHON' in r['stdout'])
        await check('remote skill actual execution',lambda:execute_backend(backend,'run_skill',{'language':'python','source':'import json,sys,socket; print(json.dumps({"sum":sum(json.loads(sys.argv[1])["values"]),"host":socket.gethostname()}))','args':[json.dumps({'values':[2,4,6]})],'timeoutMs':10000,'files':[]}),lambda r:json.loads(r['stdout'])['sum']==12 and r['executionEnvironment']=='ssh')
        first=service.manager._get_client(service.manager._get_profile_raw(profile['id']))
        await asyncio.to_thread(first.close)  # Actual transport disconnect, not a fake.
        await asyncio.sleep(.1)
        await check('SFTP reconnect reuses in-memory credential',lambda:execute_backend(backend,'read_file',{'path':'marker.txt'}),lambda r:r['content']=='REMOTE_UPDATED\n')
        second=service.manager._get_client(service.manager._get_profile_raw(profile['id']))
        assert first is not second
        report['checks'].append({'name':'dead transport replaced','passed':True})
        await check('worker recreates after transport loss',lambda:backend.execute_python('print("WORKER_RECONNECTED")'),lambda r:r['ok'] and 'WORKER_RECONNECTED' in r['stdout'])
        await check('second host profile is independent',lambda:asyncio.to_thread(service.test_connection,other['id']),lambda r:r['ok'])
        assert service.manager._get_client(service.manager._get_profile_raw(profile['id'])) is second
        report['checks'].append({'name':'second profile does not close first profile','passed':True})
        try:await backend.read_text('../outside.txt')
        except Exception:report['checks'].append({'name':'workspace traversal rejected','passed':True})
        else:raise AssertionError('Traversal accepted')
        assert (settings.workspace/'marker.txt').read_text()=='LOCAL_MUST_NOT_BE_READ'
        report['checks'].append({'name':'local twin remains untouched','passed':True})
        from omicslab.suwen.research import ResearchQuests
        from omicslab.suwen.store import PlatformStore
        store=PlatformStore(private)
        async def selected_backend(scope):
            assert scope==workspace.workspace_id
            return backend
        def require_workspace(scope):
            if scope!=workspace.workspace_id:raise ValueError('Wrong workspace')
            return workspace
        research=ResearchQuests(SimpleNamespace(store=store,backend=selected_backend,require_workspace=require_workspace))
        try:
            q=research.create(workspace.workspace_id,{'title':'Remote evidence acceptance','question':'Verify SSH evidence source',
                'dataset':'remote-fixture','protocol':'same-host','metrics':[{'name':'sum','direction':'max'}]})
            q=await check('research stage hashes SSH evidence rather than local twin',
                lambda:research.record(workspace.workspace_id,q['id'],{'stage':'scout','artifacts':['marker.txt'],'summary':'Actual remote marker'}),
                lambda value:value['stages'][0]['evidence'][0]['sha256']==hashlib.sha256(b'REMOTE_UPDATED\n').hexdigest())
            await backend.execute_python("import json,pathlib; pathlib.Path('metrics.json').write_text(json.dumps({'dataset':'remote-fixture','protocol':'same-host','metrics':{'sum':sum([2,4,6])}}))")
            await check('research baseline reads metrics computed on SSH host',
                lambda:research.record(workspace.workspace_id,q['id'],{'stage':'baseline','artifacts':['marker.txt'],'metrics_path':'metrics.json','summary':'Remote Python sum'}),
                lambda value:value['stages'][1]['measured']['sum']==12)
        finally:store.close()
    except Exception as exc:
        report['error_type']=type(exc).__name__
    finally:
        if backend:await backend.close()
        if remote_root:
            # Cleanup is constrained to this exact random directory. Do not use
            # a user path, computed parent, glob or shell recursive delete.
            assert remote_root.endswith('/'+directory) and directory.startswith('.suwen-acceptance-')
            await asyncio.to_thread(service.manager.delete,profile['id'],remote_root,recursive=True)
        service.close()
        values=report['latencies_ms']
        if values:report['p50_ms']=statistics.median(values);report['p95_ms']=sorted(values)[min(len(values)-1,int(len(values)*.95))]
        report['success']=not report.get('error_type') and all(x['passed'] for x in report['checks'])
        out=Path(__file__).resolve().parents[2]/'docs/verification/eve-1.0/ssh-live-acceptance.json'
        out.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(report,ensure_ascii=False,indent=2))
    return 0 if report['success'] else 1


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--credentials',type=Path,required=True)
    raise SystemExit(asyncio.run(main(parser.parse_args().credentials)))
