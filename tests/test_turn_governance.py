"""Regression tests at the dispatch, provider-stream and persisted-turn boundaries."""
import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace

import pytest

from omicslab.agent.governance import TurnGuard, TurnPolicy
from omicslab.agent.loop import AgentLoop
from omicslab.agent.memory import MemoryStore
from omicslab.agent.providers.base import LLMError
from omicslab.agent.streaming import merged_stream
from omicslab.agent.tools import ToolContext, ToolRegistry, ToolSpec, build_registry
from omicslab.agent.types import AgentCancelled, Conversation, ToolResult
from omicslab.config import Settings
from omicslab.session.store import ConversationStore


@pytest.fixture
def env(tmp_path):
    settings = Settings(workspace=tmp_path/'workspace', home=tmp_path/'home', provider='mock')
    settings.ensure_dirs()
    registry = build_registry(settings)
    ctx = ToolContext(settings, registry=registry, workspace=settings.workspace)
    return settings, registry, ctx


async def test_missing_directory_is_refused_then_root_remains_available(env):
    settings, registry, ctx = env
    (settings.workspace/'actual_data').mkdir()
    failed = await registry.execute(ctx, 'list_files', {'path': 'mast0912'})
    assert not failed.ok
    assert failed.data['recovery']['category'] == 'path_not_found'
    assert failed.data['recovery']['next_calls'][0]['arguments'] == {'path': '.'}
    refused = await registry.execute(ctx, 'list_files', {'path': './mast0912/'})
    assert refused.error == 'duplicate_tool_call'
    assert refused.data['guard']['executed'] is False
    assert refused.data['guard']['recovery']['category'] == 'path_not_found'
    listing = await registry.execute(ctx, 'list_files', {'path': '.'})
    assert listing.ok
    assert listing.data['entries'][0]['path'] == 'actual_data'


async def test_same_call_cannot_execute_twice_or_bypass_with_json_key_order(env):
    _, _, ctx = env
    calls = []
    async def handler(ctx, args):
        calls.append(args)
        return ToolResult('', 'probe', True, 'stable result')
    registry = ToolRegistry([ToolSpec('probe', '', {}, 'files', handler)])
    assert (await registry.execute(ctx, 'probe', {'a': 1, 'b': 2})).ok
    assert (await registry.execute(ctx, 'probe', '{"b":2,"a":1}')).error == 'duplicate_tool_call'
    assert len(calls) == 1
    assert (await registry.execute(ctx, 'probe', {'a': 3})).ok


async def test_duplicate_inflight_call_is_fail_closed(env):
    _, _, ctx = env
    started, finish = asyncio.Event(), asyncio.Event()
    async def handler(ctx, args):
        started.set()
        await finish.wait()
        return ToolResult('', 'probe', True, 'done')
    registry = ToolRegistry([ToolSpec('probe', '', {}, 'files', handler)])
    running = asyncio.create_task(registry.execute(ctx, 'probe', {}))
    await started.wait()
    assert (await registry.execute(ctx, 'probe', {})).error == 'duplicate_inflight_call'
    finish.set()
    assert (await running).ok


async def test_observable_file_change_allows_read_again(env):
    settings, registry, ctx = env
    path = settings.workspace/'data.txt'
    path.write_text('old')
    assert (await registry.execute(ctx, 'read_file', {'path': 'data.txt'})).ok
    assert (await registry.execute(ctx, 'read_file', {'path': 'data.txt'})).error == 'duplicate_tool_call'
    path.write_text('changed content')
    result = await registry.execute(ctx, 'read_file', {'path': 'data.txt'})
    assert result.ok and 'changed content' in result.content


def test_abc_cycle_is_detected_independently_of_consecutive_repeats(env):
    _, _, ctx = env
    guard = TurnGuard()
    codes = []
    for name in ['A', 'B', 'C', 'A', 'B', 'C']:
        refused, slot = guard.before(ctx, name, {})
        if refused:
            codes.append(refused.error)
        else:
            guard.inflight.discard(slot)
            guard.observe(ctx, name, {}, slot, ToolResult('', name, True, name))
    assert codes[-1] == 'tool_cycle'


async def test_same_output_with_different_arguments_stalls_before_next_execution(env):
    _, _, ctx = env
    calls = []
    async def handler(ctx, args):
        calls.append(args)
        return ToolResult('', 'probe', False, 'SSH connection refused', error='SSH connection refused')
    registry = ToolRegistry([ToolSpec('probe', '', {}, 'files', handler)])
    for i in range(3):
        result = await registry.execute(ctx, 'probe', {'path': str(i)})
        assert result.data['recovery']['category'] == 'remote_unavailable'
    assert (await registry.execute(ctx, 'probe', {'path': '4'})).error == 'output_stagnation'
    assert len(calls) == 3


async def test_tool_budget_blocks_before_handler_and_resets_with_new_turn(env):
    _, registry, ctx = env
    ctx.turn_guard = TurnGuard(TurnPolicy(tools=1))
    assert (await registry.execute(ctx, 'list_files', {'path': '.'})).ok
    result = await registry.execute(ctx, 'list_files', {'path': 'missing'})
    assert result.error == 'tool_budget' and not result.data['guard']['executed']
    ctx.turn_guard = TurnGuard(TurnPolicy(tools=1))
    assert (await registry.execute(ctx, 'list_files', {'path': '.'})).ok


async def test_stream_coalesces_tokens_and_preserves_channel_order():
    async def source():
        for kind, sentence in [('reasoning', 'Let me look at the available files. '), ('text', 'Here is the readable result.')]:
            for token in sentence.split(' '):
                yield {'type': kind, 'delta': token+' '}
        yield {'type': 'usage', 'usage': {'total_tokens': 8}}
        yield {'type': 'done', 'finish_reason': 'stop'}
    events = [e async for e in merged_stream(source())]
    assert ''.join(e['delta'] for e in events if e['type']=='reasoning').startswith('Let me look')
    assert ''.join(e['delta'] for e in events if e['type']=='text').strip() == 'Here is the readable result.'
    assert all(len(e['delta']) >= 16 for e in events if e['type'] in {'reasoning','text'})
    assert [e['type'] for e in events][-2:] == ['usage', 'done']


async def test_stream_timer_flushes_before_eof():
    release = asyncio.Event()
    async def source():
        yield {'type': 'text', 'delta': 'A readable partial paragraph that arrives before EOF'}
        await release.wait()
        yield {'type': 'text', 'delta': ' with its tail.'}
    iterator = merged_stream(source(), window=.01)
    first = await asyncio.wait_for(anext(iterator), .2)
    assert first['delta'].startswith('A readable partial')
    release.set()
    tail = [e async for e in iterator]
    assert first['delta']+''.join(e['delta'] for e in tail) == 'A readable partial paragraph that arrives before EOF with its tail.'


@pytest.mark.parametrize('mode', ['cycle', 'idle', 'deadline', 'output'])
async def test_runaway_stream_settles_and_closes(mode):
    closed = []
    async def source():
        index = 0
        try:
            while True:
                index += 1
                if mode == 'idle':
                    await asyncio.sleep(10)
                else:
                    await asyncio.sleep(.001)
                yield {'type': 'reasoning', 'delta': 'Let me look. ' if mode == 'cycle' else 'different '+str(index)}
        finally:
            closed.append(True)
    opts = {'idle': .03} if mode == 'idle' else {'duration': .03} if mode == 'deadline' else {'max_chars': 40} if mode == 'output' else {}
    async def consume():
        return [e async for e in merged_stream(source(), **opts)]
    events = await asyncio.wait_for(consume(), 1)
    expected = {'cycle': 'stream_degenerated', 'idle': 'stream_idle', 'deadline': 'stream_deadline', 'output': 'stream_output_limit'}[mode]
    assert events[-1] == {'type': 'stream_stop', 'reason': expected}
    assert closed == [True]


async def test_stream_error_flushes_tail_and_cancellation_closes():
    async def source():
        yield {'type': 'text', 'delta': 'partial'}
        raise LLMError('disconnected')
    events = []
    with pytest.raises(LLMError):
        async for event in merged_stream(source()):
            events.append(event)
    assert events == [{'type':'text','delta':'partial'}]
    cancel = asyncio.Event()
    async def waiting():
        await asyncio.sleep(10)
        yield {}
    async def consume():
        return [e async for e in merged_stream(waiting(), cancel_event=cancel)]
    task = asyncio.create_task(consume())
    await asyncio.sleep(.01)
    cancel.set()
    with pytest.raises(AgentCancelled):
        await asyncio.wait_for(task, .5)


def tool(name, **args):
    return {'id': 'call_'+name, 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}


class ScriptedProvider:
    def __init__(self, batches):
        self.batches = iter(batches)
        self.requests = []

    async def stream_chat(self, messages, tools, cfg):
        self.requests.append((messages, tools, cfg))
        for event in next(self.batches):
            yield event
        yield {'type':'done','finish_reason':'stop'}


def make_loop(env, monkeypatch, batches, policy=None):
    settings, registry, _ = env
    provider = ScriptedProvider(batches)
    monkeypatch.setattr('omicslab.agent.loop.make_provider', lambda target: provider)
    if policy:
        monkeypatch.setattr('omicslab.agent.loop.TurnGuard', lambda unused: TurnGuard(policy))
    store = ConversationStore(settings)
    loop = AgentLoop(settings, object(), store, registry, MemoryStore(settings), None, {}, {})
    return loop, provider


async def test_full_turn_missing_path_recovers_without_crash_or_manual_iterations(env, monkeypatch):
    settings, _, _ = env
    settings.max_iterations = 1  # Legacy saved preference cannot break the turn.
    (settings.workspace/'real_data').mkdir()
    loop, provider = make_loop(env, monkeypatch, [
        [{'type':'tool_calls','tool_calls':[tool('list_files',path='mast0912')]}],
        [{'type':'tool_calls','tool_calls':[tool('list_files',path='mast0912')]}],
        [{'type':'tool_calls','tool_calls':[tool('list_files',path='.')]}],
        [{'type':'text','delta':'mast0912 不存在；根目录中实际有 real_data。'}],
    ])
    conv, events = Conversation(), []
    async def emit(e): events.append(e)
    result = await loop.run(conv, '查找 mast0912', emit=emit)
    assert result['finish_reason']=='stop' and result['stop_reason']['code']=='completed'
    assert len(provider.requests)==4
    results = [e.data for e in events if e.type=='tool_result']
    assert results[1]['data']['guard']['code']=='duplicate_tool_call'
    assert results[2]['data']['entries'][0]['path']=='real_data'
    assert conv.meta['stop_reason']['code']=='completed'
    assert any(m.meta and m.meta.get('kind')=='stop_reason' for m in conv.messages)


async def test_full_turn_repeated_tool_stops_early_with_diagnosis(env, monkeypatch):
    batches = [[{'type':'tool_calls','tool_calls':[tool('list_files',path='mast0912')]}]]*20
    loop, provider = make_loop(env, monkeypatch, batches)
    result = await loop.run(Conversation(), '查找 mast0912')
    assert result['finish_reason']=='stop'
    assert result['stop_reason']['code']=='no_progress'
    assert len(provider.requests)==6
    assert 'no_progress' in result['text']


async def test_tool_budget_reserves_tools_disabled_final_answer(env, monkeypatch):
    loop, provider = make_loop(env, monkeypatch, [
        [{'type':'tool_calls','tool_calls':[tool('list_files',path='.'),tool('list_files',path='mast0912')]}],
        [{'type':'text','delta':'已检查根目录，未继续执行缺失目录调用。'}],
    ], TurnPolicy(tools=1))
    result = await loop.run(Conversation(), '检查目录')
    assert result['stop_reason']['code']=='tool_budget'
    assert provider.requests[-1][1]==[]
    assert '已检查根目录' in result['text']


async def test_step_budget_rejects_next_model_request(env, monkeypatch):
    loop, provider = make_loop(env, monkeypatch, [[{'type':'tool_calls','tool_calls':[tool('list_files',path='.')]}]], TurnPolicy(steps=1))
    result = await loop.run(Conversation(), '检查目录')
    assert result['stop_reason']['code']=='step_budget'
    assert len(provider.requests)==1


async def test_token_warning_compacts_tools_and_hard_limit_stops(env, monkeypatch):
    loop, provider = make_loop(env, monkeypatch, [
        [{'type':'usage','usage':{'total_tokens':99_000}}, {'type':'tool_calls','tool_calls':[tool('list_files',path='.')]}],
        [{'type':'usage','usage':{'total_tokens':22_000}}, {'type':'tool_calls','tool_calls':[tool('list_files',path='mast0912')]}],
    ])
    events = []
    async def emit(e): events.append(e)
    result = await loop.run(Conversation(), '检查目录', emit=emit)
    assert provider.requests[1][2].max_tokens==1024
    assert any(e.type=='resource_degraded' for e in events)
    assert result['stop_reason']['code']=='token_budget'
    assert result['stop_reason']['counters']['tokens']==121_000


async def test_llm_failure_and_user_cancel_have_auditable_reasons(env, monkeypatch):
    loop, _ = make_loop(env, monkeypatch, [])
    async def failure(*args):
        raise LLMError('offline')
        yield {}
    provider = SimpleNamespace(stream_chat=failure)
    monkeypatch.setattr('omicslab.agent.loop.make_provider', lambda target: provider)
    result = await loop.run(Conversation(), '检查目录')
    assert result['stop_reason']['code']=='llm_error'
    cancel = asyncio.Event(); cancel.set()
    conv = Conversation()
    with pytest.raises(AgentCancelled):
        await loop.run(conv, '取消', cancel_event=cancel)
    assert conv.meta['stop_reason']['code']=='cancelled'


async def test_full_turn_degenerate_stream_returns_normally_without_more_requests(env, monkeypatch):
    loop, _ = make_loop(env, monkeypatch, [])
    closed = []
    async def runaway(*args):
        try:
            while True:
                yield {'type':'reasoning','delta':'Let me look. '}
        finally:
            closed.append(True)
    monkeypatch.setattr('omicslab.agent.loop.make_provider', lambda target: SimpleNamespace(stream_chat=runaway))
    conv = Conversation()
    result = await asyncio.wait_for(loop.run(conv, '检查目录'), 2)
    assert result['finish_reason']=='stop'
    assert result['stop_reason']['code']=='stream_degenerated'
    assert result['tool_calls']==0 and closed==[True]


async def test_provider_done_never_waits_for_more_data():
    closed=[]
    async def source():
        try:
            yield {'type':'text','delta':'Finished.'}
            yield {'type':'done','finish_reason':'stop'}
            await asyncio.sleep(100)
        finally:
            closed.append(True)
    async def consume():
        return [e async for e in merged_stream(source())]
    events=await asyncio.wait_for(consume(), .5)
    assert events[-1]['type']=='done' and closed==[True]


async def test_next_turn_gets_fresh_governance_even_in_same_conversation(env, monkeypatch):
    batches = [[{'type':'tool_calls','tool_calls':[tool('list_files',path='.')]}], [{'type':'text','delta':'目录检查完成。'}]]*2
    loop, provider = make_loop(env, monkeypatch, batches)
    conv = Conversation()
    for _ in range(2):
        result=await loop.run(conv, '检查目录')
        assert result['stop_reason']['code']=='completed'
        assert result['stop_reason']['counters']['tool_calls']==1
    assert len(provider.requests)==4
