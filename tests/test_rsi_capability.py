"""The agent system prompt must state every RSI layer and its boundaries."""
from types import SimpleNamespace

from omicslab.agent.context import build_system_prompt


def _skill():
    return SimpleNamespace(name='rsi-discovery-loop',
                           description='RSI 科研发现闭环 playbook',
                           when_to_use='需要端到端科研发现时',
                           files=[])


def test_system_prompt_declares_rsi_layers_and_boundaries():
    settings = SimpleNamespace(workspace='workspace')
    agent = SimpleNamespace(name='lead', instructions='', skills=['rsi-discovery-loop'])
    prompt = build_system_prompt(settings, agent, skills={'rsi-discovery-loop': _skill()})

    assert 'RSI 自我改进' in prompt
    assert 'rsi-discovery-loop' in prompt
    assert 'discovery_*' in prompt
    assert 'Proteus' in prompt
    assert '不替换当前安装' in prompt
    assert 'mock' in prompt
