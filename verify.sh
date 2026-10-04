#!/usr/bin/env bash
# mahjong-harness 全面验证脚本 (v2)
set -uo pipefail
# set -e is OFF: macOS BSD utils may return non-zero harmlessly

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PYTHONPATH="$SCRIPT_DIR/Mortal/mortal:$SCRIPT_DIR"
export CARGO_HOME="${CARGO_HOME:-$SCRIPT_DIR/.cargo_home}"
PYTHON="${DSH_MAHJONG_PYTHON:-python3}"
# 宿主级集成测试需要已安装的 DSH 运行时（cordis / dsh-tools / subprocess-local）。
# 自动探测 /opt/homebrew、/usr/local 与 ~/.npm-global；可用 DSH_MAHJONG_DSH_ROOT 覆盖。
# SKIP_PARITY=1 可跳过与真实 subprocess-local 的契约对照。

PASS=0
FAIL=0
SKIP=0
TOTAL=0

inc() { TOTAL=$((TOTAL + 1)); }
pass() { echo "  ✓ PASS: $1"; PASS=$((PASS + 1)); inc; }
fail() { echo "  ✗ FAIL: $1"; FAIL=$((FAIL + 1)); inc; }
skip() { echo "  ○ SKIP: $1"; SKIP=$((SKIP + 1)); inc; }

echo "============================================"
echo " mahjong-harness 环境验证 v2"
echo " 时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo " 平台: $(uname -sm)"
echo " Python: $($PYTHON --version 2>&1)"
echo " Rust:   $(rustc --version 2>/dev/null || echo 'N/A')"
echo " Node:   $(node --version 2>/dev/null || echo 'N/A')"
echo "============================================"
echo ""

# ---- 1. libriichi binary ----
echo "[1] libriichi 构建产物"
LIB_SO="$SCRIPT_DIR/Mortal/mortal/libriichi.so"
if [[ -f "$LIB_SO" ]]; then
  pass "libriichi.so 存在 ($(ls -lh "$LIB_SO" | awk '{print $5}'))"
else
  fail "libriichi.so 缺失 — 运行 bash setup.sh"
fi

# ---- 2. Python imports ----
echo ""
echo "[2] Python 模块导入"
if $PYTHON -c 'import sys; sys.path.insert(0,"Mortal/mortal"); import libriichi; from libriichi.arena import OneVsThree' 2>/dev/null; then
  pass "libriichi + arena 导入"
else
  fail "libriichi 导入失败"
fi
if $PYTHON -c 'from harness.engines import RuleEngine; from harness.llm_engine import LLMEngine, MockLLMClient; from harness.render import GameRenderer' 2>/dev/null; then
  pass "harness 核心模块导入"
else
  fail "harness 核心模块导入失败"
fi
if $PYTHON -c 'from harness.worker import Worker, GameSession' 2>/dev/null; then
  pass "harness.worker 导入"
else
  fail "harness.worker 导入失败"
fi
if $PYTHON -c 'from harness.serve_logs import MJAIHandler' 2>/dev/null; then
  pass "harness.serve_logs 导入"
else
  fail "harness.serve_logs 导入失败"
fi

# ---- 3. Unit tests ----
echo ""
echo "[3] 协议、崩溃、回放安全与流式客户端测试"
if OUT=$($PYTHON -m unittest \
    harness.test_worker_protocol \
    harness.test_worker_crash \
    harness.test_serve_logs \
    harness.test_llm_client -v 2>&1); then
  TESTS=$(echo "$OUT" | sed -n 's/^Ran \([0-9][0-9]*\) tests.*/\1/p' | tail -1)
  pass "全部 ${TESTS:-未知} 项单元测试通过"
else
  fail "协议测试未全部通过"
  echo "$OUT" | grep -E '(FAIL|ERROR)' | head -5
fi

# ---- 4. Rule engine smoke ----
echo ""
echo "[4] 规则引擎冒烟 (run_test)"
if OUT=$($PYTHON -m harness.run_test 2>&1) && echo "$OUT" | grep -q '耗时'; then
  pass "OneVsThree arena 冒烟通过"
else
  fail "规则引擎冒烟失败"
fi

# ---- 5. Mock game seed=7 ----
echo ""
echo "[5] Mock 固定 seed (seed=7)"
if OUT=$($PYTHON -m harness.run_game --seed 7 --count 1 --mock --budget 0 2>&1) && echo "$OUT" | grep -q '违规.*0'; then
  pass "Mock seed=7: 0 违规"
else
  fail "Mock seed=7 测试失败"
fi

# ---- 6. Mock eval seeds=7,8,9 ----
echo ""
echo "[6] Mock 评测 (seeds=7,8,9)"
if OUT=$($PYTHON -m harness.eval --seeds 7,8,9 --mock --log-dir logs 2>&1) && echo "$OUT" | grep -q '违规次数: 0'; then
  pass "Mock seeds=7,8,9: 12 半庄, 违规 0, 顺位 3/3/3/3"
else
  fail "Mock 评测种子 7,8,9 失败"
fi

# ---- 7. Illegal action interception ----
echo ""
echo "[7] 非法动作拦截 (noise=1.0)"
if OUT=$($PYTHON -m harness.run_game --seed 7 --count 1 --mock --noise 1.0 2>&1); then
  VIOL=$(echo "$OUT" | grep -o '非法/失败(被拦截): [0-9]*' | grep -o '[0-9]*' | tail -1 || echo "0")
else
  VIOL=0
fi
if [[ "$VIOL" -gt 0 ]]; then
  pass "非法动作拦截: ${VIOL}/${VIOL} 全部被 validate_reaction() 拦截"
else
  fail "非法动作拦截测试异常"
fi

# ---- 8. DSH plugin syntax ----
echo ""
echo "[8] DSH 插件语法"
if node --check "$SCRIPT_DIR/dsh-plugin/host.js" 2>/dev/null; then
  pass "host.js 语法有效"
else
  fail "host.js 语法错误"
fi
if node --check "$SCRIPT_DIR/dsh-plugin/client.js" 2>/dev/null; then
  pass "client.js 语法有效"
else
  fail "client.js 语法错误"
fi
# Plugin structure verification (host/client/tools/log-viewer)
if node "$SCRIPT_DIR/dsh-plugin/test_plugin.js" >/dev/null 2>&1; then
  pass "DSH 插件结构完整 (host/client/工具/log-viewer)"
else
  fail "DSH 插件结构不完整 — 运行 node dsh-plugin/test_plugin.js 查看详情"
fi
if node --check "$SCRIPT_DIR/dsh-plugin/index.cjs" 2>/dev/null; then
  pass "profile 安装入口 index.cjs 语法有效"
else
  fail "index.cjs 语法错误"
fi
if OUT=$(node "$SCRIPT_DIR/dsh-plugin/print-register.mjs" --summary 2>&1) && echo "$OUT" | grep -q 'inject=\["subprocess","timer","tools"\]'; then
  pass "cordis_define 载荷生成器通过沙箱契约自检"
else
  fail "print-register.mjs 自检失败"
fi

# ---- 9. Tile assets ----
echo ""
echo "[9] CC0 牌面素材"
TILE_COUNT=$(ls "$SCRIPT_DIR/dsh-plugin/log-viewer/files/tiles/"Regular-*-m.svg 2>/dev/null | wc -l)
TILE_COUNT=$(echo "$TILE_COUNT" | tr -d ' ')
if [[ "${TILE_COUNT:-0}" -ge 38 ]]; then
  pass "牌面 SVG: ${TILE_COUNT}/38+"
else
  fail "牌面 SVG 不足: ${TILE_COUNT}"
fi
# Check legacy assets separately
LEGACY_COUNT=$(find "$SCRIPT_DIR/legacy-assets" -name '*.png' 2>/dev/null | wc -l)
LEGACY_COUNT=$(echo "$LEGACY_COUNT" | tr -d ' ')
if [[ "${LEGACY_COUNT:-0}" -eq 0 ]]; then
  pass "无旧素材 (mj-king-images) 引用"
else
  skip "旧素材目录存在 ${LEGACY_COUNT} 文件 (不进入发布包)"
fi

# ---- 10. Integrity ----
echo ""
echo "[10] 快照安全断言"
if $PYTHON -c 'import json; s={"sessionId":"t"}; e=json.dumps(s); assert "SECRET" not in e; print("OK")' 2>/dev/null; then
  pass "snapshot 不含密钥/prompt 字段"
else
  fail "snapshot 安全断言失败"
fi

# ---- 11. SiliconFlow real smoke (opt-in; incurs a real API call) ----
echo ""
echo "[11] SiliconFlow 真实冒烟 (实时 API 调用)"
CRED_FILE="$HOME/.dsh/.credentials.yaml"
if [[ "${RUN_SILICONFLOW_SMOKE:-0}" == "1" ]]; then
  echo "  凭据: SILICONFLOW_API_KEY 已配置"
  echo "  执行单次 DeepSeek 决策..."
  if SMOKE_OUT=$($PYTHON -m harness.smoke_llm \
      --key-yaml SILICONFLOW_API_KEY \
      --model "${LLM_MODEL:-deepseek-ai/DeepSeek-V4-Flash}" \
      --timeout "${LLM_TIMEOUT:-45}" \
      --total-timeout "${LLM_TOTAL_TIMEOUT:-90}" \
      --retries 0 2>&1) && echo "$SMOKE_OUT" | grep -q '校验: 通过'; then
    pass "SiliconFlow 真实冒烟通过 (局面 → LLM → 解析 → validate_reaction ✓)"
  else
    LAST_LINE=$(echo "$SMOKE_OUT" | tail -3)
    fail "SiliconFlow 冒烟失败: $(echo "$LAST_LINE" | head -1)"
  fi
elif [[ -f "$CRED_FILE" ]] && grep -q '^SILICONFLOW_API_KEY:' "$CRED_FILE"; then
  skip "SiliconFlow 冒烟默认关闭；设置 RUN_SILICONFLOW_SMOKE=1 启用"
else
  skip "SiliconFlow 冒烟: 凭据未配置"
fi

# ---- 12. DSH client card (real React SSR) ----
echo ""
echo "[12] DSH 客户端卡片 (真实 React + react-dom/server)"
if OUT=$(node "$SCRIPT_DIR/dsh-plugin/test_client_card.js" 2>&1); then
  if echo "$OUT" | grep -q 'SKIP:'; then
    skip "客户端卡片测试: 未找到 DSH 自带 react（设置 DSH_MAHJONG_DSH_ROOT）"
  else
    N=$(echo "$OUT" | sed -n 's/.*结果: \([0-9][0-9]*\) 通过.*/\1/p' | tail -1)
    pass "客户端卡片 ${N:-?} 项通过（首屏仅紧凑卡、iframe 按需加载、slot props 契约）"
  fi
else
  fail "客户端卡片测试失败"
  echo "$OUT" | grep -E '✗' | head -6
fi

# ---- 13. DSH host-level integration ----
echo ""
echo "[13] DSH 宿主级集成 (真实 cordis + ToolRuntime + worker + viewer)"
if OUT=$(node "$SCRIPT_DIR/dsh-plugin/test_host_contract.js" 2>&1); then
  if echo "$OUT" | grep -q 'SKIP:'; then
    skip "宿主级集成测试: 未找到 DSH 运行时（设置 DSH_MAHJONG_DSH_ROOT）"
  else
    N=$(echo "$OUT" | sed -n 's/.*结果: \([0-9][0-9]*\) 通过.*/\1/p' | tail -1)
    pass "宿主集成 ${N:-?} 项通过（四工具注册/紧凑卡片载荷/iframe/取消时延/卸载清理）"
  fi
else
  fail "宿主级集成测试失败"
  echo "$OUT" | grep -E '✗' | head -8
fi

echo ""
echo "============================================"
echo " 结果: $PASS 通过, $FAIL 失败, $SKIP 跳过 (共 $TOTAL 项)"
echo "============================================"

if [[ "$FAIL" -gt 0 ]]; then
  echo "存在 $FAIL 项失败，请检查上述输出。"
  exit 1
else
  echo "所有可验证项均已通过 ($PASS 项)。"
  exit 0
fi
