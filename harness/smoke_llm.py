"""单次真实 LLM 调用冒烟测试:抓一个局面 → prompt → DeepSeek → 解析 → 校验。

不会把 key 打印到任何地方。
"""

from __future__ import annotations

import json
import os
import sys

MORTAL_PY_DIR = os.path.join(os.path.dirname(__file__), "..", "Mortal", "mortal")
sys.path.insert(0, os.path.abspath(MORTAL_PY_DIR))

from libriichi.arena import OneVsThree  # noqa: E402

from harness.engines import RuleEngine, MjaiLogEngine  # noqa: E402
from harness.llm_engine import (  # noqa: E402
    OpenAICompatibleClient,
    MjaiActionBuilder,
    parse_llm_action,
)
from harness.render import GameRenderer  # noqa: E402


class SnapshotEngine(MjaiLogEngine):
    """抓取第一个可行动局面(带真实 state),决策交给规则引擎。"""

    def __init__(self):
        super().__init__("snapshot")
        self.snap = None
        self._rule = RuleEngine("inner")

    def set_player_ids(self, player_ids):
        super().set_player_ids(player_ids)
        self._rule.set_player_ids(player_ids)

    def react_one(self, game_state) -> str:
        if self.snap is None:
            self.snap = game_state
        return self._rule.react_one(game_state)


def _load_key(env_name: str, yaml_key: str) -> str:
    env = os.environ.get(env_name)
    if env:
        return env
    cred = os.path.expanduser("~/.dsh/.credentials.yaml")
    if os.path.exists(cred):
        with open(cred, "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith(f"{yaml_key}:"):
                    return line.split(":", 1)[1].strip().strip('"').strip("'")
    return ""


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default=os.environ.get("LLM_BASE_URL", "https://api.siliconflow.cn/v1"))
    ap.add_argument("--model", default=os.environ.get("LLM_MODEL", "deepseek-ai/DeepSeek-V4-Flash"))
    ap.add_argument("--key-env", default="LLM_API_KEY")
    ap.add_argument("--key-yaml", default="CHATGPT_API_KEY")
    args = ap.parse_args()

    key = _load_key(args.key_env, args.key_yaml)
    if not key:
        print(f"没有找到 {args.key_env}(env 或 ~/.dsh/.credentials.yaml)")
        return 1

    snap = SnapshotEngine()
    log_dir = os.path.join(os.path.dirname(__file__), "..", "logs")
    os.makedirs(log_dir, exist_ok=True)
    arena = OneVsThree(disable_progress_bar=True, log_dir=os.path.abspath(log_dir))
    arena.py_vs_py(
        challenger=snap,
        champion=RuleEngine("champion"),
        seed_start=(11, 0),
        seed_count=1,
    )
    if snap.snap is None:
        print("没有抓到局面")
        return 1

    gs = snap.snap
    seat = snap._seat_of(gs.game_index)
    renderer = GameRenderer(seat)
    state_desc = renderer.render(gs)
    prompt = (
        "你在打日本麻将(天凤四人标准规则)。你是本局玩家之一,只能看到自己可见的信息。\n"
        f"以下是对当前局面的完整描述:\n\n{state_desc}\n\n"
        "【你的任务】从上面的「合法动作」中选择一个动作。只能选择合法动作,禁止无中生有。\n"
        "【输出要求】只输出一个 JSON 对象,不要任何解释。格式:\n"
        '{"action":"dahai","pai":"3m","tsumogiri":false} / {"action":"reach"} / '
        '{"action":"hora"} / {"action":"pass"} / {"action":"pon"} / {"action":"chi"} / '
        '{"action":"ankan","pai":"5m"} / {"action":"kakan","pai":"5m"} / '
        '{"action":"daiminkan"} / {"action":"ryukyoku"}'
    )

    print("===== 局面渲染 =====")
    print(state_desc)
    print("\n===== 调用模型 ... =====")
    client = OpenAICompatibleClient(
        api_key=key, base_url=args.base_url, model=args.model
    )
    text = client.chat(prompt)
    print(f"模型回复: {text[:300]}")

    action = parse_llm_action(text)
    print(f"\n解析动作: {action}")
    if action is None:
        print("!! 解析失败")
        return 1
    mjai_json = MjaiActionBuilder(seat, gs.state).build(action)
    print(f"mjai 动作: {mjai_json}")
    try:
        gs.state.validate_reaction(mjai_json)
        print("校验: 通过 ✓")
    except Exception as e:
        print(f"校验: 失败 ✗ {e}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
