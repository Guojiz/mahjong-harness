"""抓取一局对局的可见状态样本,用于观察 prompt 渲染效果。"""

from __future__ import annotations

import os
import sys
import json

MORTAL_PY_DIR = os.path.join(os.path.dirname(__file__), "..", "Mortal", "mortal")
sys.path.insert(0, os.path.abspath(MORTAL_PY_DIR))

from libriichi.arena import OneVsThree  # noqa: E402
from harness.engines import RuleEngine, JsonLogEngine  # noqa: E402


def main() -> int:
    log_dir = os.path.join(os.path.dirname(__file__), "..", "logs")
    os.makedirs(log_dir, exist_ok=True)
    arena = OneVsThree(disable_progress_bar=True, log_dir=os.path.abspath(log_dir))

    recorder = JsonLogEngine("recorder")
    arena.py_vs_py(
        challenger=recorder,
        champion=RuleEngine("champion"),
        seed_start=(7, 0),
        seed_count=1,
    )

    print(f"共记录 {len(recorder.steps)} 个可行动局面\n")
    for i in [0, 2, 5]:
        if i < len(recorder.steps):
            step = recorder.steps[i]
            print(f"===== step[{i}] seat={step['seat']} =====")
            print("--- brief_info() ---")
            print(step["brief"])
            print("--- 最近事件(前3条) ---")
            events = json.loads(step["events_json"])
            for ev in events[:3]:
                print(json.dumps(ev, ensure_ascii=False)[:160])
            print("--- legal ---")
            print(json.dumps(step["legal"], ensure_ascii=False))
            print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
