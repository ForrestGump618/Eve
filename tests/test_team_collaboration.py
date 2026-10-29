"""Team-orchestration skill and agent prompt must teach captain-led dispatch."""
from pathlib import Path
from types import SimpleNamespace

import pytest

from omicslab.agent.context import build_system_prompt
from omicslab.suwen.teams import create_team, send_message, team_mailbox
from test_suwen_platform import p


def test_team_collaboration_skill_declares_dispatch_workflow():
    path = Path(__file__).resolve().parents[1] / "omicslab" / "skills" / "team-collaboration" / "SKILL.md"
    text = path.read_text(encoding="utf-8")
    assert "name: team-collaboration" in text
    assert "team_create" in text
    assert 'team_message(recipient="all")' in text
    assert "team_mailbox" in text
    assert "讨论公开可追溯" in text


def test_lead_prompt_lists_team_skill_and_dispatch_rule():
    settings = SimpleNamespace(workspace="workspace")
    skills = {
        "team-collaboration": SimpleNamespace(
            name="team-collaboration",
            description="队长型多智能体协作技能",
            when_to_use="需要多角色并行或交叉讨论时",
            files=["SKILL.md"],
        ),
        "rsi-discovery-loop": SimpleNamespace(
            name="rsi-discovery-loop",
            description="RSI 科研发现闭环",
            when_to_use="需要端到端科研发现时",
            files=["SKILL.md"],
        ),
    }
    agent = SimpleNamespace(name="lead", instructions="", skills=["team-collaboration"])
    prompt = build_system_prompt(settings, agent, skills=skills)
    assert "team-collaboration" in prompt
    assert "team_message" in prompt
    assert "recipient=\"all\"" in prompt


@pytest.mark.asyncio
async def test_broadcast_delivers_one_user_message_to_every_member(p):
    team = create_team(p, "ws_main", {"title": "Dispatch", "members": [
        {"id": "a", "goal": "investigate A"},
        {"id": "b", "goal": "review B"},
    ]})
    message = await send_message(p, "ws_main", team["id"], "user", "all",
                                  "current user request: verify the file and discuss", wake=False)
    assert [row["member"] for row in message["deliveries"]] == ["a", "b"]
    mailbox = team_mailbox(p, "ws_main", team["id"])
    assert len(mailbox) == 1
    assert mailbox[0]["sender"] == "user" and mailbox[0]["recipient"] == "all"
    assert "current user request" in mailbox[0]["content"]
