"""冒烟测试:用纯规则引擎跑通 OneVsThree arena,验证 mjai-log 链路。

用法(在 mahjong-harness 根目录):
    ../Mortal/.venv/Scripts/python.exe -m harness.run_test
"""

from __future__ import annotations

import os
import sys
import time

# libriichi.pyd 所在目录
MORTAL_PY_DIR = os.path.join(os.path.dirname(__file__), "..", "Mortal", "mortal")
sys.path.insert(0, os.path.abspath(MORTAL_PY_DIR))

import libriichi  # noqa: E402
from libriichi.arena import OneVsThree  # noqa: E402

from harness.engines import RuleEngine  # noqa: E402


def main() -> int:
    log_dir = os.path.join(os.path.dirname(__file__), "..", "logs")
    arena = OneVsThree(disable_progress_bar=True, log_dir=os.path.abspath(log_dir))

    t0 = time.time()
    seed_start = (42, 0)  # (组号, 变体);同组号+局数+本场 → 牌山确定
    seed_count = 1        # 1 组 = 4 个半庄,挑战者分别坐 0/1/2/3 位
    rankings = arena.py_vs_py(
        challenger=RuleEngine("rule-challenger"),
        champion=RuleEngine("rule-champion"),
        seed_start=seed_start,
        seed_count=seed_count,
    )
    elapsed = time.time() - t0

    print(f"seed={seed_start}, count={seed_count}")
    print(f"挑战者(规则引擎)各名次次数: 顺位0={rankings[0]} 顺位1={rankings[1]} "
          f"顺位2={rankings[2]} 顺位3={rankings[3]}")
    print(f"耗时 {elapsed:.1f}s")
    print(f"日志目录: {os.path.abspath(log_dir)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
