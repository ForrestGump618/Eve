from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from omicslab.agent.types import Conversation
from omicslab.config import Settings
from omicslab.runtime.desktop_harness import DesktopHarness


@pytest.mark.asyncio
async def test_unified_turn_does_not_send_hidden_call_or_iteration_limits(tmp_path: Path) -> None:
    calls: list[tuple[str, dict]] = []

    class Adapter(DesktopHarness):
        async def rpc(self, method: str, **params):
            calls.append((method, params))
            if method == "create":
                return {"id": "task_unbounded"}
            if method == "task.snapshot":
                return {
                    "status": "completed",
                    "events": [],
                    "stream": {"text": "verified result"},
                    "tokens": 42,
                    "steps": [{
                        "output": {
                            "text": "verified result",
                            "traceId": "trace_unbounded",
                            "sources": [],
                            "verification": {"passed": True},
                        }
                    }],
                }
            raise AssertionError(f"unexpected RPC: {method}")

    settings = Settings(
        workspace=tmp_path / "workspace",
        home=tmp_path / "home",
        provider="openai",
        model="test-model",
    )
    settings.ensure_dirs()
    llm = SimpleNamespace(
        provider="openai",
        model="test-model",
        family="openai",
        api_key="test-only-key",
        api_base="https://example.invalid/v1",
        label="test",
    )
    settings.resolve_llm = lambda provider=None, model=None: llm  # type: ignore[method-assign]
    loop = SimpleNamespace(settings=settings, registry=SimpleNamespace(platform=None), _save=lambda conv: None)
    backend = SimpleNamespace(kind="local", root=settings.workspace)
    adapter = Adapter({"token": "unused", "pipe": "unused"})

    result = await adapter.run(
        loop,
        Conversation(),
        "return the verified result",
        backend=backend,
        run_ctx=SimpleNamespace(permission_mode="full", run_id="run_test"),
    )

    create = next(params for method, params in calls if method == "create")
    assert create["limits"] == {"maxTokens": 240000, "maxWallMs": 630000}
    assert "maxCalls" not in create["limits"]
    assert "maxTurns" not in create["limits"]
    assert "maxIterations" not in create["limits"]
    assert create["steps"][0]["timeoutMs"] == 600000
    assert result["finish_reason"] == "stop"
    assert result["text"] == "verified result"


@pytest.mark.asyncio
@pytest.mark.parametrize('outcome',['verified','budget','failed'])
async def test_per_model_parameters_and_failed_turn_transcripts(tmp_path,outcome):
    from omicslab.config import LLMTarget
    calls=[];saved=[]
    text='verified result' if outcome=='verified' else '预算已用尽，执行记录已保存'
    class Adapter(DesktopHarness):
        async def rpc(self,method,**params):
            calls.append((method,params))
            if method=='create':return {'id':'task'}
            if method=='task.snapshot':
                return {'status':'failed' if outcome=='failed' else 'completed','events':[],
                    'stream':{'text':'partial analysis' if outcome=='failed' else text},'tokens':100,
                    'steps':[{'error':'upstream unavailable' if outcome=='failed' else None,'output':{
                        'text':text,'verification':{'passed':outcome=='verified'},
                        'completion':'partial' if outcome=='budget' else 'verified',
                        **({'stopReason':'token_budget'} if outcome=='budget' else {})}}]}
            raise AssertionError(method)
    settings=Settings(workspace=tmp_path/'workspace',home=tmp_path/'home');settings.ensure_dirs()
    target=LLMTarget('openai','model','openai','https://example.invalid/v1','fixture-only','test')
    settings.resolve_llm=lambda **kwargs:target
    capabilities={'openai::model':{'context_window':16000,'max_output':2000,'temperature':0.7,
        'modalities':['text','image'],'token_parameter':'max_completion_tokens'}}
    config=SimpleNamespace(get=lambda *args:{'value':{'capabilities':capabilities}})
    gateway=SimpleNamespace(prepare=lambda *args:(None,None,target))
    platform=SimpleNamespace(config=config,models=gateway)
    loop=SimpleNamespace(settings=settings,registry=SimpleNamespace(platform=platform),
        _resolve_agent=lambda agent:SimpleNamespace(id=agent),_save=lambda conv:saved.append(conv.to_dict()))
    conv=Conversation();adapter=Adapter({'pipe':'unused','token':'unused'})
    result=await adapter.run(loop,conv,'analyze',backend=SimpleNamespace(kind='local',root=settings.workspace),
        run_ctx=SimpleNamespace(permission_mode='full',run_id='run'),run_id='run')
    passed=next(params for method,params in calls if method=='create')['modelConfig']
    assert passed['temperature']==0.7
    assert passed['contextWindow']==16000 and passed['maxOutput']==2000
    assert passed['modalities']==['text','image']
    assert passed['tokenParameter']=='max_completion_tokens'
    assert conv.messages[-1].role=='assistant'
    if outcome=='failed':
        assert 'partial analysis' in conv.messages[-1].content
        assert 'upstream unavailable' in conv.messages[-1].content
        assert result['finish_reason']=='error'
    elif outcome=='budget':
        assert result['stop_reason']['code']=='token_budget'
        assert result['evidence_gate']['passed'] is False
    else:
        assert result['finish_reason']=='stop'
