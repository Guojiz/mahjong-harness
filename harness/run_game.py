"""闭环跑局:LLM 玩家 vs 3 个规则陪练,跑一组(4 个半庄,LLM 各坐一次)。

配置:优先环境变量,其次项目根目录 .env(LLM_API_KEY / LLM_BASE_URL / LLM_MODEL)。
无 key 时自动用 mock 客户端。

用法:
    python -m harness.run_game --seed 7 --count 1 [--model deepseek-ai/DeepSeek-V4-Flash]
    python -m harness.run_game --seed 7 --count 1 --budget 40   # 只调 40 次真 LLM,其余规则兜底
"""

from __future__ import annotations

import argparse
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


def load_dotenv() -> None:
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip())


def main() -> int:
    load_dotenv()
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7, help="组号(确定性发牌)")
    ap.add_argument("--count", type=int, default=1, help="组数(1 组 = 4 个半庄,LLM 各坐一次)")
    ap.add_argument("--noise", type=float, default=0.0, help="mock 乱码概率(测试非法动作拦截)")
    ap.add_argument("--api-key", default=os.environ.get("LLM_API_KEY", ""), help="LLM API key")
    ap.add_argument("--base-url", default=os.environ.get("LLM_BASE_URL", "https://api.siliconflow.cn/v1"))
    ap.add_argument("--model", default=os.environ.get("LLM_MODEL", "deepseek-ai/DeepSeek-V4-Flash"))
    ap.add_argument("--temperature", type=float, default=0.2)
    ap.add_argument("--max-tokens", type=int, default=256)
    ap.add_argument("--timeout", type=float, default=45.0, help="单次 LLM 请求超时秒数")
    ap.add_argument("--retries", type=int, default=1, help="单次 LLM 请求失败后的重试次数")
    ap.add_argument("--budget", type=int, default=None, help="真实 LLM 调用次数预算,超限转规则兜底")
    ap.add_argument("--no-skip-calls", action="store_true", help="不跳过被动鸣牌决策(全量调 LLM)")
    ap.add_argument("--progress-every", type=int, default=50, help="每多少次决策打印一次进度,0 表示关闭")
    ap.add_argument("--mock", action="store_true", help="强制用 mock 客户端(不用真实 API)")
    ap.add_argument("--log-dir", default=os.path.join(os.path.dirname(__file__), "..", "logs"))
    args = ap.parse_args()

    if args.mock or not args.api_key:
        client = MockLLMClient(noise_prob=args.noise, seed=args.seed)
        client_name = f"mock(noise={args.noise})"
    else:
        if args.budget is None:
            print("!! 警告: 未设置 --budget,将对所有决策调用真实 LLM,"
                  "4 个半庄约数百次调用、耗时可能数小时。Ctrl-C 可中断。", flush=True)
        client = OpenAICompatibleClient(
            api_key=args.api_key,
            base_url=args.base_url,
            model=args.model,
            temperature=args.temperature,
            max_tokens=args.max_tokens,
            timeout=args.timeout,
            retries=args.retries,
        )
        client_name = args.model

    llm = LLMEngine(
        client=client,
        name=client_name,
        skip_call_decisions=not args.no_skip_calls,
        max_decisions=args.budget,
        progress_every=args.progress_every,
    )
    os.makedirs(args.log_dir, exist_ok=True)
    arena = OneVsThree(
        disable_progress_bar=True,
        log_dir=os.path.abspath(args.log_dir),
    )

    print(
        f"开始跑局: seed={args.seed}, 半庄数={args.count * 4}, "
        f"client={client_name}, budget={args.budget}, timeout={args.timeout}s, retries={args.retries}",
        flush=True,
    )
    t0 = time.time()
    rankings = arena.py_vs_py(
        challenger=llm,
        champion=RuleEngine("rule-champion"),
        seed_start=(args.seed, 0),
        seed_count=args.count,
    )
    elapsed = time.time() - t0

    print("=" * 56)
    print(f"玩家: {client_name}")
    print(f"seed={args.seed}, 组数={args.count} (半庄数={args.count * 4})")
    print(f"LLM 各名次次数: 1位={rankings[0]} 2位={rankings[1]} 3位={rankings[2]} 4位={rankings[3]}")
    print(f"决策总数: {llm.total_decisions}  真 LLM 调用: {llm.llm_calls}  "
          f"自动跳过/兜底: {llm.delegated}  非法/失败(被拦截): {llm.violations}")
    print(f"耗时: {elapsed:.1f}s  (真 LLM 调用平均 {elapsed / max(1, llm.llm_calls):.1f}s)")
    if hasattr(client, "usage_total") and client.usage_total["total_tokens"]:
        u = client.usage_total
        print(f"Token 用量: prompt={u['prompt_tokens']} completion={u['completion_tokens']} "
              f"total={u['total_tokens']}")
    print(f"日志: {os.path.abspath(args.log_dir)}")
    print("=" * 56)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
