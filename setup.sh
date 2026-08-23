#!/usr/bin/env bash
# mahjong-harness macOS/Linux 一键环境安装脚本
# 用法: bash setup.sh [--skip-build] [--python python3.12]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MORTAL_DIR="$SCRIPT_DIR/Mortal"
MORTAL_MORTAL_DIR="$MORTAL_DIR/mortal"
CARGO_HOME="${CARGO_HOME:-$SCRIPT_DIR/.cargo_home}"
export CARGO_HOME

SKIP_BUILD=false
PYTHON_BIN="${DSH_MAHJONG_PYTHON:-python3}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    --python) PYTHON_BIN="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

echo "=== mahjong-harness 环境安装 ==="
echo "工作目录: $SCRIPT_DIR"
echo "Python:    $PYTHON_BIN ($($PYTHON_BIN --version 2>&1 || echo 'NOT FOUND'))"
echo "Rust:      $(rustc --version 2>/dev/null || echo 'NOT FOUND')"
echo "Cargo:     $(cargo --version 2>/dev/null || echo 'NOT FOUND')"
echo ""

# ---- 1. Build libriichi ----
LIBRIIICHI_SO="$MORTAL_MORTAL_DIR/libriichi.so"
case "$(uname -s)" in
  Darwin) LIBRIIICHI_BUILD="$MORTAL_DIR/target/release/libriichi.dylib" ;;
  Linux) LIBRIIICHI_BUILD="$MORTAL_DIR/target/release/libriichi.so" ;;
  *) echo "ERROR: 当前脚本仅支持 macOS/Linux"; exit 1 ;;
esac

if $SKIP_BUILD; then
  echo "[1/4] 跳过 libriichi 构建 (--skip-build)"
else
  echo "[1/4] 构建 libriichi (Rust)..."
  if ! command -v cargo &>/dev/null; then
    echo "ERROR: 需要 Rust 工具链。安装: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
  fi
  mkdir -p "$CARGO_HOME"
  (cd "$MORTAL_DIR" && cargo build -p libriichi --lib --release)
  echo "  构建完成: $LIBRIIICHI_BUILD"
fi

# ---- 2. Copy libriichi to Mortal/mortal/ ----
echo "[2/4] 复制 libriichi 到 Mortal/mortal/"
if [[ -f "$LIBRIIICHI_BUILD" ]]; then
  cp "$LIBRIIICHI_BUILD" "$LIBRIIICHI_SO"
  echo "  $LIBRIIICHI_SO"
elif [[ -f "$LIBRIIICHI_SO" ]]; then
  echo "  libriichi.so 已存在，跳过复制"
else
  echo "ERROR: 找不到 libriichi 构建产物。请先运行 cargo build。"
  exit 1
fi

# ---- 3. Verify Python import ----
echo "[3/4] 验证 Python 导入 libriichi..."
PYTHONPATH="$MORTAL_MORTAL_DIR:$SCRIPT_DIR" "$PYTHON_BIN" -c "
import sys
sys.path.insert(0, '$MORTAL_MORTAL_DIR')
import libriichi
from libriichi.arena import OneVsThree
from harness.engines import RuleEngine
from harness.llm_engine import LLMEngine, MockLLMClient
from harness.render import GameRenderer
print('  libriichi + harness 模块导入成功')
"

# ---- 4. Run protocol tests ----
echo "[4/4] 运行协议层单测..."
PYTHONPATH="$MORTAL_MORTAL_DIR:$SCRIPT_DIR" "$PYTHON_BIN" -m unittest harness.test_worker_protocol harness.test_worker_crash -v 2>&1 | tail -6
echo ""

# ---- Summary ----
echo "=== 安装完成 ==="
echo ""
echo "运行命令（在仓库根目录）："
echo "  # 设置 PYTHONPATH (可写入 ~/.bashrc 或 ~/.zshrc)"
echo "  export PYTHONPATH=\"$MORTAL_MORTAL_DIR:$SCRIPT_DIR\""
echo ""
echo "  # 纯规则引擎冒烟"
echo "  python3 -m harness.run_test"
echo ""
echo "  # mock 固定 seed 对局"
echo "  python3 -m harness.run_game --seed 7 --count 1 --mock"
echo ""
echo "  # mock 评测"
echo "  python3 -m harness.eval --seeds 7,8,9 --mock"
echo ""
echo "  # 运行全部协议测试"
echo "  python3 -m unittest discover -s harness -p 'test_*.py' -v"
echo ""
echo "  # 真实 LLM 最小冒烟 (需要设置 LLM_API_KEY)"
echo "  python3 -m harness.smoke_llm"
echo ""
echo "DSH 插件重新注册: 见 dsh-plugin/README.md"
