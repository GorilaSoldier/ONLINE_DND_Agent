import json
import urllib.request


def call_action(player_input: str, session_id: str = None):
    body = {
        "adventure_id": "lost-mine-of-phandelver",
        "chapter_id": "ch1",
        "player_input": player_input,
    }
    if session_id:
        body["session_id"] = session_id

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        "http://127.0.0.1:8001/api/game/action",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw)


def test_action(player_input: str, session_id: str = None):
    data = call_action(player_input, session_id)

    print("=" * 60)
    print(f"输入：{player_input}")
    print(f"session_id：{data['session_id']}")
    print(f"意图：{json.dumps(data['intent'], ensure_ascii=False)}")
    print(f"检定：{data.get('checks', [])}")
    print(f"状态变化：{data.get('state_changes', [])}")
    print(f"GM 回复：{data['gm_text']}")
    return data["session_id"]


if __name__ == "__main__":
    sid = test_action("查看周围")
    sid = test_action("与修达交谈", sid)
    sid = test_action("悄悄偷走桌上的地图", sid)
    sid = test_action("偷走绝冬城补给箱", sid)
    sid = test_action("前往三猪小径", sid)
