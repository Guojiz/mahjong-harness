"""LLM 玩家适配器 & 规则陪练引擎。

这些引擎实现 libriichi 的 `mjai-log` Python agent 接口:
  - engine_type = "mjai-log"   (new_py_agent 据此选择 MjaiLogBatchAgent)
  - name: str
  - set_player_ids(player_ids): 被调用一次,告知本引擎在各场对局中分别坐哪个座位
  - react_batch(game_states) -> list[str]: 每场对局需要决策时,
    收到该场当前的 (game_index, state, events_json),返回一个 mjai 动作 JSON 字符串
  - start_game / end_kyoku / end_game: 生命周期回调

注意:本模块是自研代码(MIT),只依赖 libriichi 的公开 Python API,不引入 torch。
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

# tehai[34] 的索引顺序对应牌名(与 libriichi consts 一致,不含赤宝)
TILE_NAMES_34 = (
    ["1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m"]
    + ["1p", "2p", "3p", "4p", "5p", "6p", "7p", "8p", "9p"]
    + ["1s", "2s", "3s", "4s", "5s", "6s", "7s", "8s", "9s"]
    + ["E", "S", "W", "N", "P", "F", "C"]
)
TILE_NAME_BY_INDEX = {i: name for i, name in enumerate(TILE_NAMES_34)}


class MjaiLogEngine:
    """mjai-log 引擎基类:处理批处理索引与座位号的映射。"""

    engine_type = "mjai-log"

    def __init__(self, name: str = "mjai-log-engine"):
        self.name = name
        self._player_ids: List[int] = []

    def set_player_ids(self, player_ids):
        self._player_ids = list(player_ids)

    def _seat_of(self, game_index: int) -> int:
        if not self._player_ids:
            raise RuntimeError("set_player_ids 尚未被调用")
        return self._player_ids[game_index % len(self._player_ids)]

    def start_game(self, index: int):
        pass

    def end_kyoku(self, index: int):
        pass

    def end_game(self, index: int, scores):
        pass

    def react_one(self, game_state) -> str:
        raise NotImplementedError

    def react_batch(self, game_states) -> List[str]:
        return [self.react_one(gs) for gs in game_states]


class RuleEngine(MjaiLogEngine):
    """纯规则陪练:摸切(打出刚摸到的牌),所有副露/立直/和牌一律 pass。

    用于验证引擎链路、给 LLM 玩家当陪练。
    """

    def __init__(self, name: str = "tsumogiri"):
        super().__init__(name)

    def _dahai(self, seat: int, pai: str, tsumogiri: bool) -> str:
        return json.dumps(
            {"type": "dahai", "actor": seat, "pai": pai, "tsumogiri": tsumogiri},
            ensure_ascii=False,
        )

    def _first_tile_in_hand(self, tehai) -> Optional[str]:
        for i, count in enumerate(tehai):
            if count > 0:
                return TILE_NAME_BY_INDEX[i]
        return None

    def react_one(self, game_state) -> str:
        state = game_state.state
        seat = self._seat_of(game_state.game_index)
        cans = state.last_cans

        if cans.can_discard:
            tsumo = state.last_self_tsumo()
            if tsumo is not None:
                # 摸切
                return self._dahai(seat, tsumo, True)
            # 副露后需要打牌:从手牌里挑一张(先打掉第 34 张里的第一张,即索引最小的)
            pai = self._first_tile_in_hand(state.tehai)
            if pai is None:
                raise RuntimeError(f"[{self.name}] 需要打牌但手牌为空: {state.brief_info()}")
            return self._dahai(seat, pai, False)

        # 可鸣/可和但选择过
        return json.dumps({"type": "none"})


class JsonLogEngine(MjaiLogEngine):
    """把每步可见状态记录下来,实际决策委托给规则引擎。

    用于调试/抓取状态样本,或验证状态渲染。
    """

    def __init__(self, name: str = "json-log"):
        super().__init__(name)
        self.steps: List[Dict[str, Any]] = []
        self._rule = RuleEngine("json-log-inner")

    def set_player_ids(self, player_ids):
        super().set_player_ids(player_ids)
        self._rule.set_player_ids(player_ids)

    def react_one(self, game_state) -> str:
        state = game_state.state
        seat = self._seat_of(game_state.game_index)
        self.steps.append(
            {
                "seat": seat,
                "game_index": game_state.game_index,
                "events_json": game_state.events_json,
                "brief": state.brief_info(),
                "legal": {
                    k: getattr(state.last_cans, k)
                    for k in (
                        "can_discard", "can_chi_low", "can_chi_mid", "can_chi_high",
                        "can_pon", "can_daiminkan", "can_kakan", "can_ankan",
                        "can_riichi", "can_tsumo_agari", "can_ron_agari",
                        "can_ryukyoku", "target_actor",
                    )
                },
            }
        )
        return self._rule.react_one(game_state)
