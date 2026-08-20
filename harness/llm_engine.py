"""LLM 玩家引擎 + 可插拔 LLM 客户端。

流程:可见状态 → prompt → LLM 输出 → 解析为 mjai 动作 → validate_reaction 拦截
非法动作(违规计数)→ 合法兜底动作。

客户端接口:
    class LLMClient:
        def chat(self, user_prompt: str) -> str  # 返回模型文本

实现:
    - OpenAICompatibleClient: 走 OpenAI /chat/completions 协议(DeepSeek 兼容)
    - MockLLMClient: 无 key 时的确定性假 LLM,用于闭环验证
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from .engines import MjaiLogEngine, RuleEngine, TILE_NAME_BY_INDEX
from .render import GameRenderer

# ---------------------------------------------------------------- 客户端

class LLMClient:
    name = "base"

    def chat(self, user_prompt: str) -> str:
        raise NotImplementedError


class OpenAICompatibleClient(LLMClient):
    """OpenAI /chat/completions 协议(DeepSeek 官方 API 即是此协议)。"""

    name = "openai-compatible"

    def __init__(
        self,
        api_key: str,
        base_url: str = "https://api.deepseek.com",
        model: str = "deepseek-chat",
        temperature: float = 0.2,
        max_tokens: int = 256,
        timeout: float = 45.0,
        retries: int = 2,
        retry_backoff: float = 2.0,
    ): 
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.timeout = timeout
        self.retries = retries
        self.retry_backoff = retry_backoff
        self.usage_total = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

    def chat(self, user_prompt: str) -> str:
        last_err: Optional[Exception] = None
        attempts = max(1, self.retries + 1)
        for attempt in range(attempts):
            try:
                return self._chat_once(user_prompt)
            except Exception as e:  # noqa: BLE001
                last_err = e
                if attempt < attempts - 1:
                    time.sleep(self.retry_backoff * (attempt + 1))
        raise RuntimeError(f"LLM 请求失败(尝试 {attempts} 次): {last_err}")

    def _chat_once(self, user_prompt: str) -> str:
        url = f"{self.base_url}/chat/completions"
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": "你是一个日本麻将玩家,严格按要求输出。"},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "stream": False,
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"LLM HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:500]}") from e
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError) as e:
            raise RuntimeError(f"LLM 响应结构异常: {str(data)[:500]}") from e
        usage = data.get("usage")
        if isinstance(usage, dict):
            for k in self.usage_total:
                self.usage_total[k] += int(usage.get(k, 0))
        return content


class MockLLMClient(LLMClient):
    """无 key 时的确定性假 LLM:按简单规则输出 JSON 动作,用于验证闭环。

    param `noise_prob`: >0 时以该概率输出乱码,用于测试非法动作拦截。
    """

    name = "mock"

    def __init__(self, noise_prob: float = 0.0, seed: int = 0):
        self.noise_prob = noise_prob
        self._rng = __import__("random").Random(seed)
        self.calls = 0

    def chat(self, user_prompt: str) -> str:
        self.calls += 1
        # 从 prompt 中提取手牌、刚摸的牌与合法动作,模拟 LLM 决策
        m = re.search(r"刚摸 (\S+?)\)", user_prompt)
        tsumo = m.group(1) if m else None
        m = re.search(r"【手牌】([^\n]+)", user_prompt)
        hand_line = m.group(1) if m else ""
        # 去掉"(刚摸 ...)"部分,只留手牌列表
        hand_tiles = re.findall(r"[0-9][mps]r?|[ESWNPFC]", hand_line.split("(刚摸")[0])
        m = re.search(r"【合法动作】(.+)", user_prompt)
        legal = m.group(1) if m else ""

        if self.noise_prob > 0 and self._rng.random() < self.noise_prob:
            return "这张牌不错,我觉得应该打 9z"  # 乱码,应触发兜底

        if "hora 自摸和牌" in legal or "hora 荣和" in legal:
            return json.dumps({"action": "hora"})
        if "dahai" in legal:
            if tsumo:
                return json.dumps({"action": "dahai", "pai": tsumo, "tsumogiri": True})
            # 副露后打牌:打手牌最后一张(简单启发)
            if hand_tiles:
                return json.dumps({"action": "dahai", "pai": hand_tiles[-1], "tsumogiri": False})
        return json.dumps({"action": "pass"})

# ---------------------------------------------------------------- 动作构建

_AKA = {"5m": "5mr", "5p": "5pr", "5s": "5sr"}


def _akaize(tile: str, akas: List[int]) -> str:
    return _AKA.get(tile, tile)


class MjaiActionBuilder:
    """把 LLM 的粗粒度动作转成合法 mjai 事件 JSON(port 自 MortalBatchAgent)。"""

    def __init__(self, seat: int, state):
        self.seat = seat
        self.state = state

    def build(self, action: Dict[str, Any]) -> Optional[str]:
        kind = action.get("action")
        if kind == "pass":
            return json.dumps({"type": "none"})
        if kind == "dahai":
            pai = action.get("pai")
            tsumogiri = bool(action.get("tsumogiri", False))
            return json.dumps(
                {"type": "dahai", "actor": self.seat, "pai": pai, "tsumogiri": tsumogiri},
                ensure_ascii=False,
            )
        if kind == "reach":
            return json.dumps({"type": "reach", "actor": self.seat})
        if kind == "hora":
            cans = self.state.last_cans
            if cans.can_tsumo_agari and not cans.can_ron_agari:
                target = self.seat
            else:
                target = cans.target_actor
            return json.dumps({"type": "hora", "actor": self.seat, "target": target})
        if kind == "ryukyoku":
            return json.dumps({"type": "ryukyoku"})
        if kind == "chi":
            return self._chi()
        if kind == "pon":
            return self._pon()
        if kind == "daiminkan":
            return self._daiminkan()
        if kind == "ankan":
            return self._ankan()
        if kind == "kakan":
            return self._kakan()
        return None

    # ---- 鸣牌构造 ----
    def _last_pai(self) -> str:
        pai = self.state.last_kawa_tile()
        if pai is None:
            raise RuntimeError("无上一张河牌")
        return pai

    def _akas(self) -> List[int]:
        return list(self.state.akas_in_hand)

    def _can_akaize(self, pai: str) -> bool:
        """赤宝替换:吃/碰/杠时可把 4/5/6 与赤5 互换(仅当手中有赤5)。"""
        akas = self._akas()
        if pai == "4m" and akas[0]:
            return True
        if pai == "6m" and akas[0]:
            return True
        if pai == "5m" and akas[0]:
            return True
        if pai == "4p" and akas[1]:
            return True
        if pai == "6p" and akas[1]:
            return True
        if pai == "5p" and akas[1]:
            return True
        if pai == "4s" and akas[2]:
            return True
        if pai == "6s" and akas[2]:
            return True
        if pai == "5s" and akas[2]:
            return True
        return False

    def _chi(self) -> Optional[str]:
        cans = self.state.last_cans
        pai = self._last_pai()
        # 确定 chi 类型(取 LLM 提供的或自动选一个可用的)
        kind = "mid"
        if cans.can_chi_low:
            kind = "low"
        elif cans.can_chi_mid:
            kind = "mid"
        elif cans.can_chi_high:
            kind = "high"
        else:
            return None

        def num(t: str) -> int:
            return int(t[0])

        if kind == "low":
            consumed = [f"{num(pai)+1}{pai[1]}", f"{num(pai)+2}{pai[1]}"]
        elif kind == "mid":
            consumed = [f"{num(pai)-1}{pai[1]}", f"{num(pai)+1}{pai[1]}"]
        else:  # high
            consumed = [f"{num(pai)-2}{pai[1]}", f"{num(pai)-1}{pai[1]}"]

        # 赤宝替换(与 Mortal 一致:5 的周围 4/6 可换赤)
        if self._can_akaize(pai):
            consumed = [_akaize(c, self._akas()) for c in consumed]
        return json.dumps(
            {"type": "chi", "actor": self.seat, "target": cans.target_actor,
             "pai": pai, "consumed": consumed},
            ensure_ascii=False,
        )

    def _pon(self) -> Optional[str]:
        cans = self.state.last_cans
        if not cans.can_pon:
            return None
        pai = self._last_pai()
        if self._can_akaize(pai):
            consumed = [_akaize(pai, self._akas()), pai]
        else:
            consumed = [pai, pai]
        return json.dumps(
            {"type": "pon", "actor": self.seat, "target": cans.target_actor,
             "pai": pai, "consumed": consumed},
            ensure_ascii=False,
        )

    def _daiminkan(self) -> Optional[str]:
        cans = self.state.last_cans
        if not cans.can_daiminkan:
            return None
        pai = self._last_pai()
        if pai.startswith("5") and self._akas()[{"m": 0, "p": 1, "s": 2}[pai[1]]]:
            consumed = [_akaize(pai, self._akas()), pai, pai]
        else:
            consumed = [pai, pai, pai]
        return json.dumps(
            {"type": "daiminkan", "actor": self.seat, "target": cans.target_actor,
             "pai": pai, "consumed": consumed},
            ensure_ascii=False,
        )

    def _ankan(self) -> Optional[str]:
        cans = self.state.last_cans
        if not cans.can_ankan:
            return None
        candidates = list(self.state.ankan_candidates())
        if not candidates:
            return None
        pai = candidates[0]
        if self._can_akaize(pai):
            consumed = [_akaize(pai, self._akas()), pai, pai, pai]
        else:
            consumed = [pai, pai, pai, pai]
        return json.dumps(
            {"type": "ankan", "actor": self.seat, "consumed": consumed},
            ensure_ascii=False,
        )

    def _kakan(self) -> Optional[str]:
        cans = self.state.last_cans
        if not cans.can_kakan:
            return None
        candidates = list(self.state.kakan_candidates())
        if not candidates:
            return None
        pai = candidates[0]
        if self._can_akaize(pai):
            consumed = [_akaize(pai, self._akas()), pai, pai]
        else:
            consumed = [pai, pai, pai]
        return json.dumps(
            {"type": "kakan", "actor": self.seat, "pai": pai, "consumed": consumed},
            ensure_ascii=False,
        )

# ---------------------------------------------------------------- 引擎

def parse_llm_action(text: str) -> Optional[Dict[str, Any]]:
    """从 LLM 输出中提取动作 JSON。容忍前后缀文本。"""
    if not text:
        return None
    m = re.search(r"\{.*?\}", text, re.DOTALL)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    if not isinstance(obj, dict) or "action" not in obj:
        return None
    return obj


class LLMEngine(MjaiLogEngine):
    """LLM 玩家。用 client 做决策,非法动作被拦截并计数。

    `skip_call_decisions=True` 时:若当前唯一合法动作是被动鸣牌(吃/碰/杠,
    不含荣和/打牌/立直/自摸),直接 pass 不调 LLM —— 大幅降低调用成本。
    `max_decisions` 预算用完后转规则兜底,防止失控烧钱。
    """

    def __init__(
        self,
        client: LLMClient,
        name: str = "llm-player",
        skip_call_decisions: bool = True,
        max_decisions: Optional[int] = None,
        progress_every: int = 0,
    ):
        super().__init__(name)
        self.client = client
        self.skip_call_decisions = skip_call_decisions
        self.max_decisions = max_decisions
        self.progress_every = progress_every
        self.violations = 0
        self.total_decisions = 0
        self.llm_calls = 0
        self.delegated = 0
        self.actions_taken: List[Dict[str, Any]] = []
        self.game_results: List[Dict[str, Any]] = []
        self._rule = RuleEngine("llm-fallback")

    def set_player_ids(self, player_ids):
        super().set_player_ids(player_ids)
        self._rule.set_player_ids(player_ids)

    def end_game(self, index: int, scores):
        seat = self._seat_of(index)
        rank = sorted(range(4), key=lambda i: scores[i], reverse=True).index(seat) + 1
        self.game_results.append({"seat": seat, "scores": list(scores), "rank": rank})

    def _only_passive_calls(self, cans) -> bool:
        """是否只有被动鸣牌可选(吃/碰/杠),且无更重要的动作。"""
        return (
            not cans.can_discard
            and not cans.can_riichi
            and not cans.can_tsumo_agari
            and not cans.can_ron_agari
            and not cans.can_ryukyoku
            and (cans.can_chi or cans.can_pon or cans.can_kan)
        )

    def _renderer_for(self, game_index: int) -> GameRenderer:
        seat = self._seat_of(game_index)
        return GameRenderer(seat)

    def _build_prompt(self, game_state) -> str:
        seat = self._seat_of(game_state.game_index)
        renderer = GameRenderer(seat)
        state_desc = renderer.render(game_state)

        return f"""你在打日本麻将(天凤四人标准规则)。你是本局玩家之一,只能看到自己可见的信息。
以下是对当前局面的完整描述:

{state_desc}

【你的任务】从上面的「合法动作」中选择一个动作。只能选择合法动作,禁止无中生有。
【输出要求】只输出一个 JSON 对象,不要任何解释、注释或多余文字。格式:
  - 打牌: {{"action":"dahai","pai":"3m","tsumogiri":false}}
    其中 pai 必须是手牌中的牌;如果打的是刚摸的牌,tsumogiri 为 true,否则为 false。
  - 立直: {{"action":"reach"}}   (声明后你还要再打一张)
  - 和牌: {{"action":"hora"}}
  - 吃: {{"action":"chi"}}
  - 碰: {{"action":"pon"}}
  - 大明杠: {{"action":"daiminkan"}}
  - 暗杠: {{"action":"ankan","pai":"5m"}}
  - 加杠: {{"action":"kakan","pai":"5m"}}
  - 放弃鸣牌/荣和: {{"action":"pass"}}
  - 流局: {{"action":"ryukyoku"}}"""

    def _safety_fallback(self, state, seat: int) -> str:
        """非法输出时的兜底:选一个绝对合法的动作。"""
        cans = state.last_cans
        if cans.can_discard:
            tsumo = state.last_self_tsumo()
            if tsumo is not None:
                return json.dumps(
                    {"type": "dahai", "actor": seat, "pai": tsumo, "tsumogiri": True},
                    ensure_ascii=False,
                )
            # 副露后打牌:挑手牌第一张
            for i, count in enumerate(state.tehai):
                if count > 0:
                    return json.dumps(
                        {"type": "dahai", "actor": seat,
                         "pai": TILE_NAME_BY_INDEX[i], "tsumogiri": False},
                        ensure_ascii=False,
                    )
        if cans.can_agari:
            target = seat if cans.can_tsumo_agari else cans.target_actor
            return json.dumps({"type": "hora", "actor": seat, "target": target})
        return json.dumps({"type": "none"})

    def react_one(self, game_state) -> str:
        state = game_state.state
        seat = self._seat_of(game_state.game_index)
        self.total_decisions += 1

        cans = state.last_cans
        if self.progress_every > 0 and self.total_decisions % self.progress_every == 0:
            print(
                f"[进度] 决策={self.total_decisions} 真调用={self.llm_calls} "
                f"兜底/跳过={self.delegated} 违规={self.violations}",
                flush=True,
            )
        # 预算用尽 → 转规则兜底
        if self.max_decisions is not None and self.llm_calls >= self.max_decisions:
            self.delegated += 1
            return self._rule.react_one(game_state)

        # 只有被动鸣牌可选 → 自动 pass
        if self.skip_call_decisions and self._only_passive_calls(cans):
            self.delegated += 1
            return json.dumps({"type": "none"})

        prompt = self._build_prompt(game_state)
        self.llm_calls += 1
        if self.client.name != "mock":
            print(
                f"[LLM] 开始请求 #{self.llm_calls} (决策={self.total_decisions})",
                flush=True,
            )
        try:
            text = self.client.chat(prompt)
        except Exception as e:
            print(f"[LLM] 请求失败 #{self.llm_calls}: {e}", flush=True)
            self.violations += 1
            self.actions_taken.append({"error": str(e), "seat": seat})
            return self._safety_fallback(state, seat)

        action = parse_llm_action(text)
        mjai_json = None
        if action is not None:
            try:
                mjai_json = MjaiActionBuilder(seat, state).build(action)
            except Exception:
                mjai_json = None

        if mjai_json is None:
            self.violations += 1
            self.actions_taken.append(
                {"seat": seat, "raw": text, "fallback": True}
            )
            return self._safety_fallback(state, seat)

        # 非法动作拦截:validate_reaction 不通过 → 兜底 + 违规计数
        try:
            state.validate_reaction(mjai_json)
        except Exception:
            self.violations += 1
            self.actions_taken.append(
                {"seat": seat, "raw": text, "action": mjai_json, "fallback": True}
            )
            return self._safety_fallback(state, seat)

        self.actions_taken.append({"seat": seat, "action": mjai_json})
        return mjai_json
