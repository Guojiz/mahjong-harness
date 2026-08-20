"""评测脚本:固定 seed 批量对局,聚合顺位/和了率/放铳率/违规数/token 成本。

用法:
    python -m harness.eval --seeds 7,8,9 --mock           # mock 基准
    python -m harness.eval --seeds 7 --budget 40          # 真实 LLM 小预算
    python -m harness.eval --seeds 1,2,3                  # 真实 LLM 全量(警告:耗时长)
"""

from __future__ import annotations

import argparse
import gzip
import glob
import json
import os
import sys
import time

MORTAL_PY_DIR = os.path.join(os.path.dirname(__file__), "..", "Mortal", "mortal")
sys.path.insert(0, os.path.abspath(MORTAL_PY_DIR))

from libriichi.arena import OneVsThree  # noqa: E402

from harness.engines import RuleEngine  # noqa: E402
from harness.llm_engine import (  # noqa: E402
    LLMEngine,
    MockLLMClient,
    OpenAICompatibleClient,
)
from harness.run_game import load_dotenv  # noqa: E402

# 每组 4 个半庄,文件后缀 a/b/c/d 对应挑战者(被测 LLM)座位 0/1/2/3
SEAT_BY_SUFFIX = {"a": 0, "b": 1, "c": 2, "d": 3}


def parse_game_stats(log_path: str, llm_seat: int) -> dict:
    """从 mjai 日志统计该半庄 LLM 座位的和了/放铳。"""
    stats = {"wins": 0, "deal_ins": 0, "hanchans": 1, "hora_count": 0}
    with gzip.open(log_path, "rt", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "hora":
                actor = ev.get("actor")
                target = ev.get("target")
                stats["hora_count"] += 1
                if actor == llm_seat:
                    stats["wins"] += 1
                if target == llm_seat:
                    stats["deal_ins"] += 1
    return stats


def main() -> int:
    load_dotenv()
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", default="7,8,9", help="逗号分隔的组号列表")
    ap.add_argument("--variant", type=int, default=0)
    ap.add_argument("--api-key", default=os.environ.get("LLM_API_KEY", ""))
    ap.add_argument("--base-url", default=os.environ.get("LLM_BASE_URL", "https://api.siliconflow.cn/v1"))
    ap.add_argument("--model", default=os.environ.get("LLM_MODEL", "deepseek-ai/DeepSeek-V4-Flash"))
    ap.add_argument("--temperature", type=float, default=0.2)
    ap.add_argument("--max-tokens", type=int, default=256)
    ap.add_argument("--budget", type=int, default=None)
    ap.add_argument("--mock", action="store_true")
    ap.add_argument("--no-skip-calls", action="store_true")
    ap.add_argument("--log-dir", default=os.path.join(os.path.dirname(__file__), "..", "logs"))
    args = ap.parse_args()

    seeds = [int(s) for s in args.seeds.split(",") if s.strip()]

    if args.mock or not args.api_key:
        client = MockLLMClient(seed=seeds[0])
        client_name = "mock"
    else:
        if args.budget is None:
            print("!! 警告: 未设置 --budget,全量调用真实 LLM,可能数小时。Ctrl-C 中断。", flush=True)
        client = OpenAICompatibleClient(
            api_key=args.api_key, base_url=args.base_url, model=args.model,
            temperature=args.temperature, max_tokens=args.max_tokens,
        )
        client_name = args.model

    os.makedirs(args.log_dir, exist_ok=True)
    arena = OneVsThree(disable_progress_bar=True, log_dir=os.path.abspath(args.log_dir))

    agg = {"rank": [0, 0, 0, 0], "wins": 0, "deal_ins": 0, "hanchans": 0, "violations": 0}
    t0 = time.time()

    for seed in seeds:
        llm = LLMEngine(
            client=client, name=client_name,
            skip_call_decisions=not args.no_skip_calls,
            max_decisions=args.budget,
        )
        arena.py_vs_py(
            challenger=llm,
            champion=RuleEngine("rule-champion"),
            seed_start=(seed, args.variant),
            seed_count=1,
        )
        for res in llm.game_results:
            agg["rank"][res["rank"] - 1] += 1
            agg["hanchans"] += 1
        agg["violations"] += llm.violations

        # 从日志统计和了/放铳
        for suffix, seat in SEAT_BY_SUFFIX.items():
            pattern = os.path.join(args.log_dir, f"{seed}_{args.variant}_{suffix}.json.gz")
            files = glob.glob(pattern)
            if files:
                s = parse_game_stats(files[0], seat)
                agg["wins"] += s["wins"]
                agg["deal_ins"] += s["deal_ins"]

    elapsed = time.time() - t0
    n = agg["hanchans"] or 1

    print("=" * 60)
    print(f"评测对象: {client_name}   种子: {args.seeds}   半庄数: {agg['hanchans']}")
    print(f"顺位分布: 1位={agg['rank'][0]}  2位={agg['rank'][1]}  "
          f"3位={agg['rank'][2]}  4位={agg['rank'][3]}  平均顺位={sum((i+1)*c for i, c in enumerate(agg['rank']))/n:.2f}")
    print(f"和了率: {agg['wins']}/{n} = {agg['wins']/n*100:.1f}%   "
          f"放铳率: {agg['deal_ins']}/{n} = {agg['deal_ins']/n*100:.1f}%")
    print(f"违规次数: {agg['violations']}")
    if hasattr(client, "usage_total") and client.usage_total["total_tokens"]:
        u = client.usage_total
        print(f"Token 成本: prompt={u['prompt_tokens']} completion={u['completion_tokens']} "
              f"total={u['total_tokens']}  平均 {u['total_tokens']/n:.0f}/半庄")
    print(f"耗时: {elapsed:.0f}s")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
