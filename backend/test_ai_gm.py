"""简单流式端点测试"""
import json
import urllib.request


def call_action_stream(player_input: str, session_id: str = None):
    body = {
        "adventure_id": "lost-mine-of-phandelver",
        "chapter_id": "ch1",
        "player_input": player_input,
    }
    if session_id:
        body["session_id"] = session_id

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        "http://127.0.0.1:8001/api/game/action/stream",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    gm_text = ""
    meta = None
    with urllib.request.urlopen(req, timeout=60) as resp:
        for line in resp:
            line = line.decode("utf-8").strip()
            if not line or not line.startswith("data: "):
                continue
            ev = json.loads(line[6:])
            if ev.get("type") == "meta":
                meta = ev
            elif ev.get("type") == "narrative_chunk":
                gm_text += ev.get("text", "")

    return {"gm_text": gm_text, "session_id": meta.get("session_id") if meta else None,
            "checks": meta.get("checks", []) if meta else [],
            "state_changes": meta.get("state_changes", []) if meta else []}


def test_action(player_input: str, session_id: str = None):
    data = call_action_stream(player_input, session_id)

    print("=" * 60)
    print(f"输入：{player_input}")
    print(f"session_id：{data['session_id']}")
    print(f"检定：{data['checks']}")
    print(f"状态变化：{data['state_changes']}")
    print(f"GM 回复：{data['gm_text'][:200]}")
    return data["session_id"]


if __name__ == "__main__":
    sid = test_action("查看周围")
    sid = test_action("与修达交谈", sid)
    sid = test_action("悄悄偷走桌上的地图", sid)
    sid = test_action("偷走绝冬城补给箱", sid)
    sid = test_action("前往三猪小径", sid)
