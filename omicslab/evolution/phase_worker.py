"""One fresh native Eve session, booted from a frozen Proteus snapshot."""
from __future__ import annotations

import asyncio
from dataclasses import replace
import json
import os
from pathlib import Path
import sys

from .proteus_adapter import EvolutionPolicy, SURFACES
from .runtime import checked_path, tree_files


async def run_phase(payload):
    from ..agent import loop as native
    from ..agent.approvals import Approver
    from ..agent.memory import MemoryStore
    from ..agent.templates import AgentTemplate
    from ..agent.skills import load_skills
    from ..agent.tools import ToolRegistry, build_registry
    from ..agent.types import AgentCancelled, Conversation, ToolError
    from ..config import Settings
    from ..session.store import ConversationStore

    candidate = checked_path(payload['candidate'])
    active = Path(__file__).resolve().parents[3]
    policy = EvolutionPolicy(**payload['policy'])
    # No persistent host profile, global memories or credential file is loaded.
    settings = Settings(workspace=candidate, home=candidate.parent / '.eve-state' / f"ep{payload['episode']}-{payload['phase']}",
                        provider='custom_openai', model=payload['model'],
                        api_base=os.environ.get('EVE_RSI_BASE_URL', ''),
                        request_timeout_s=policy.phase_timeout_s, allow_shell=False,
                        approval_policy='auto', allow_file_write=True)
    original = build_registry(settings)
    skills = load_skills(replace(settings, workspace=active))
    specs = [s for s in original.specs() if s.name in {'list_files', 'read_file', 'write_file', 'skill_list', 'skill_view'}]
    write = original.get('write_file')

    def scoped_handler(spec):
        async def handler(ctx, arguments):
            ctx.scoped_skills = skills
            if spec.name in {'list_files', 'read_file', 'write_file'}:
                path = arguments.get('path') or '.'
                target = checked_path(candidate / path)
                if not target.is_relative_to(candidate) or '.git' in target.relative_to(candidate).parts:
                    raise ToolError('Only candidate files are accessible; snapshot metadata is framework-owned')
                if target.is_dir():
                    list(tree_files(target))
            return await (write_candidate(ctx, arguments) if spec.name == 'write_file' else spec.handler(ctx, arguments))
        return handler

    async def write_candidate(ctx, arguments):
        target = ctx.resolve_in_workspace(arguments.get('path'))
        relative = target.relative_to(candidate).as_posix()
        if not any(relative.startswith(path + '/') for path in SURFACES.values()):
            raise ToolError('Write must target a declared evolution surface')
        if '.git' in target.relative_to(candidate).parts:
            raise ToolError('Snapshot metadata is framework-owned')
        if len(str(arguments.get('content', '')).encode('utf-8')) > policy.max_file_bytes:
            raise ToolError('Candidate file exceeds evolution policy')
        return await write.handler(ctx, arguments)

    registry = ToolRegistry([replace(s, handler=scoped_handler(s), requires_approval=False) for s in specs])
    events, pending = [], {}
    calls = 0
    native_factory = native.make_provider

    class CountedProvider:
        def __init__(self, provider):
            self.provider = provider

        async def stream_chat(self, messages, tools, config):
            nonlocal calls
            if calls >= payload['max_turns']:
                raise AgentCancelled('Proteus phase model-call allowance exhausted')
            calls += 1
            events.append({'tool': None, 'path': '', 'ok': None, 'turn': calls})
            async for event in self.provider.stream_chat(messages, tools, config):
                yield event

    native.make_provider = lambda target: CountedProvider(native_factory(target))

    async def emit(event):
        data = event.data
        if event.type == 'tool_call':
            pending[data['id']] = {'tool': data.get('name'),
                                   'path': str(data.get('arguments', {}).get('path', '')).replace('\\', '/')}
        elif event.type == 'tool_result':
            call = pending.pop(data.get('id'), None)
            if call:
                events.append({**call, 'ok': data.get('ok') is True, 'turn': calls})

    # __file__ is active/src/omicslab/evolution; instructions are active/instructions.
    instruction = active / 'instructions' / 'SYSTEM.md'
    guidance = instruction.read_text(encoding='utf-8') if instruction.is_file() else ''
    remaining = policy.max_context_bytes
    carried = []
    for directory in ('notes', 'tools'):
        if not (active / directory).is_dir():
            continue
        for path in sorted(tree_files(active / directory)):
            if path.suffix.lower() not in {'.md', '.txt'} or remaining <= 0:
                continue
            content = path.read_bytes()[:remaining].decode('utf-8', errors='replace')
            remaining -= len(content.encode('utf-8'))
            carried.append(f'## {path.relative_to(active).as_posix()}\n{content}')
    guidance += '\n\nFrozen notes and tool guidance (reference content):\n' + '\n\n'.join(carried)
    agent = AgentTemplate(id='evolve', name='Eve', description='Harness evolution', instructions=guidance,
                          toolsets=['files', 'skills'])
    loop = native.AgentLoop(settings, None, ConversationStore(settings), registry, MemoryStore(settings),
                            None, {'evolve': agent}, skills)
    prompt = (f"{payload['prompt']}\n\nWritable candidate root: {candidate}\n"
              'Read relevant files before making a small change. Surfaces: '
              + ', '.join(SURFACES.values()) + '.\n'
              'Use skill_list/skill_view for frozen skills; edits activate only in the next accepted episode. '
              'notes/ and tools/ Markdown carry bounded guidance into fresh phases; tools/ does not register executable tools. '
              'Execution and regression tests happen at the episode boundary. '
              'Report observations and remaining checks without claiming unexecuted tests passed.')
    result = {}
    try:
        result = await asyncio.wait_for(loop.run(Conversation(agent='evolve'), prompt, emit=emit,
                                                agent_id='evolve', approver=Approver(policy='auto'),
                                                extra_system='This isolated evolution phase has only the listed file and skill tools. '
                                                'There is no kernel, shell, delegation, network tool, or deployment tool. '
                                                'Use available tools only; regression execution is controller-owned.'),
                                        timeout=policy.phase_timeout_s)
        ok = (calls > 0 and result.get('finish_reason') == 'stop' and not result.get('error')
              and result.get('stop_reason', {}).get('code') == 'completed')
    except (AgentCancelled, asyncio.TimeoutError):
        ok = False
        result = {'stop_reason': {'code': 'phase_budget_or_timeout'}}
    finally:
        native.make_provider = native_factory
    return {'ok': ok, 'turns': calls, 'events': events,
            'error': '' if ok else result.get('stop_reason', {}).get('code', 'native_phase_failed')}


def main():
    payload = json.load(sys.stdin)
    try:
        result = asyncio.run(run_phase(payload))
    except Exception as exc:
        # Native transcripts remain local; the public trajectory contains no model prose.
        result = {'ok': False, 'turns': 0, 'events': [], 'error': type(exc).__name__}
    print(json.dumps(result))


if __name__ == '__main__':
    main()
