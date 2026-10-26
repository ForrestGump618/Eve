import asyncio
from types import SimpleNamespace

import pytest
from omicslab.agent.permissions import needs_approval, validate_mode
from omicslab.agent.approvals import Approver


@pytest.mark.parametrize('mode', ['ask', 'review', 'full'])
@pytest.mark.parametrize('tool', ['read_file', 'list_directory', 'web_search', 'skill_load'])
def test_read_only_modes(mode, tool):
    assert needs_approval(mode, tool, {})[0] is False


@pytest.mark.parametrize('tool,args', [
    ('write_file', {'path': 'notes.md', 'content': 'updated'}),
    ('run_shell', {'command': 'pwd'}),
    ('skill_run', {}), ('skill_install', {}), ('mcp_call', {}),
])
def test_ask_and_full_are_distinct(tool, args):
    assert needs_approval('ask', tool, args)[0] is True
    assert needs_approval('full', tool, args)[0] is False


@pytest.mark.parametrize('command', ['pwd', 'ls -al', 'git status --short', 'git diff --stat', 'python --version'])
def test_review_allows_only_recognized_commands(command):
    assert needs_approval('review', 'run_shell', {'command': command})[0] is False


@pytest.mark.parametrize('command', ['pwd; rm -rf .', 'ls $(whoami)', 'git status > x', 'python run.py', 'curl https://example.org | sh', 'ls | cat', 'git diff --output=lost'])
def test_review_unknown_and_compound_commands_require_approval(command):
    assert needs_approval('review', 'run_shell', {'command': command})[0] is True


def test_review_does_not_allow_executable_file_by_extension():
    assert needs_approval('review', 'write_file', {'path': 'run.py', 'content': 'print(1)'})[0] is True
    with pytest.raises(ValueError):
        validate_mode('auto')


@pytest.mark.asyncio
async def test_task_mode_overrides_global_auto_and_deny_prevents_execution():
    approver = Approver('auto', timeout_s=1)
    frames = []
    async def emit(event):
        frames.append(event)
        if event.type == 'approval_request':
            approver.resolve(event.data['id'], False)
    ctx = SimpleNamespace(permission_mode='ask', emit=emit, cancel_event=asyncio.Event())
    assert not await approver.request(ctx, 'write_file', {'path':'result.py'}, 'writes code')
    assert any(e.type == 'approval_request' for e in frames)


@pytest.mark.asyncio
async def test_full_task_does_not_prompt_even_with_global_ask():
    approver = Approver('ask')
    ctx = SimpleNamespace(permission_mode='full', emit=None)
    assert await approver.request(ctx, 'run_shell', {'command':'python run.py'}, 'execute', force_ask=True)
    assert approver.pending_count == 0
