"""mjai 事件 → 可读局面渲染。

设计原则(接手卡):引擎(引擎日志)是单一事实来源;模型能看到的一切必然已写入
事件日志。本模块把 events_json 渲染成给 LLM 的中文局面描述,并结合 PlayerState
的安全 getter(手牌/向听/听牌/振听/合法动作)。

注意:不要调用 state.brief_info() —— 它是 debug 用,在部分局面会触发 Rust panic。
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from .engines import TILE_NAME_BY_INDEX

# 役牌:字牌自风/场风按座次计算
_WINDS = ["E", "S", "W", "N"]          # 东南西北
_HONORS = ["E", "S", "W", "N", "P", "F", "C"]

# 宝牌指示牌的下一张即为宝牌(字牌循环:东南西北白发中)
_DORA_NEXT = {
    "1m": "2m", "2m": "3m", "3m": "4m", "4m": "5m", "5m": "6m",
    "6m": "7m", "7m": "8m", "8m": "9m", "9m": "1m",
    "1p": "2p", "2p": "3p", "3p": "4p", "4p": "5p", "5p": "6p",
    "6p": "7p", "7p": "8p", "8p": "9p", "9p": "1p",
    "1s": "2s", "2s": "3s", "3s": "4s", "4s": "5s", "5s": "6s",
    "6s": "7s", "7s": "8s", "8s": "9s", "9s": "1s",
    "E": "S", "S": "W", "W": "N", "N": "E",
    "P": "F", "F": "C", "C": "P",
}

SUIT_M = "m"
SUIT_P = "p"
SUIT_S = "s"


def dora_of(marker: str) -> str:
    """宝牌指示牌 → 实际宝牌。"""
    return _DORA_NEXT.get(marker, marker)


def _tile_sort_key(tile: str) -> int:
    if tile.endswith("r"):  # 赤5,按其本家 5 处理
        tile = tile[0] + tile[1]
    if tile.endswith("m"):
        return int(tile[0])
    if tile.endswith("p"):
        return 10 + int(tile[0])
    if tile.endswith("s"):
        return 20 + int(tile[0])
    return 30 + _HONORS.index(tile)


def sort_tiles(tiles: List[str]) -> List[str]:
    return sorted(tiles, key=_tile_sort_key)


def hand_from_tehai(tehai, akas) -> List[str]:
    """PlayerState.tehai([34]) + akas_in_hand → 手牌名列表。"""
    tiles: List[str] = []
    for i, count in enumerate(tehai):
        if count > 0:
            tiles.extend([TILE_NAME_BY_INDEX[i]] * count)
    for i, has_aka in enumerate(akas):
        if has_aka:
            tiles.append(["5mr", "5pr", "5sr"][i])
    return sort_tiles(tiles)


def _fmt_meld(ev: Dict[str, Any]) -> str:
    typ = ev["type"]
    consumed = ev.get("consumed", [])
    if typ == "chi":
        # 顺子:consumed 是两张 + 被吃的一张
        tiles = sort_tiles(consumed + [ev.get("pai", "")])
        suit = tiles[0][-1] if tiles else "?"
        nums = [t[0] for t in tiles]
        return f"吃 {''.join(nums)}{suit}"
    if typ in ("pon", "daiminkan", "kakan", "ankan"):
        label = {"pon": "碰", "daiminkan": "大明杠", "kakan": "加杠", "ankan": "暗杠"}[typ]
        pai = ev.get("pai") or (consumed[0] if consumed else "?")
        return f"{label} {pai}"
    return f"{typ}({consumed})"


class GameRenderer:
    """把一局的事件日志 + PlayerState 渲染成中文局面描述。"""

    def __init__(self, seat: int, player_names: Optional[List[str]] = None):
        self.seat = seat
        self.player_names = player_names or [f"玩家{i}" for i in range(4)]

    def render(self, game_state) -> str:
        state = game_state.state
        events = json.loads(game_state.events_json)

        ctx = self._parse_events(events)
        return self._compose(ctx, state)

    # ---- 事件解析 ----
    def _parse_events(self, events: List[Dict[str, Any]]) -> Dict[str, Any]:
        ctx: Dict[str, Any] = {
            "kyoku": "", "honba": 0, "oya": 0, "scores": None,
            "dora_markers": [], "kawa": [[] for _ in range(4)],
            "melds": [[] for _ in range(4)], "riichi": [False] * 4,
            "riichi_accepted": [False] * 4, "tsumo_count": 0,
            "last_discard": None,
        }
        for ev in events:
            typ = ev["type"]
            if typ == "start_kyoku":
                ctx["kyoku"] = f"{ev['bakaze']}{ev['kyoku']}"
                ctx["honba"] = ev["honba"]
                ctx["oya"] = ev["oya"]
                ctx["scores"] = ev["scores"]
                ctx["dora_markers"] = [ev["dora_marker"]]
            elif typ == "dora":
                ctx["dora_markers"].append(ev["dora_marker"])
            elif typ == "dahai":
                actor = ev["actor"]
                ctx["kawa"][actor].append(ev["pai"])
                ctx["last_discard"] = (actor, ev["pai"])
            elif typ in ("chi", "pon", "daiminkan", "kakan", "ankan"):
                ctx["melds"][ev["actor"]].append(_fmt_meld(ev))
            elif typ == "reach":
                ctx["riichi"][ev["actor"]] = True
            elif typ == "reach_accepted":
                ctx["riichi_accepted"][ev["actor"]] = True
            elif typ == "tsumo":
                ctx["tsumo_count"] += 1
            elif typ == "hora":
                ctx.setdefault("hora", []).append(
                    f"和了: {self.player_names[ev['actor']]} "
                    f"(荣和{self.player_names[ev['target']] if ev.get('target') is not None and ev['target'] != ev['actor'] else '自摸'})"
                )
            elif typ == "ryukyoku":
                ctx.setdefault("hora", []).append("流局")
        return ctx

    # ---- 组装 ----
    def _compose(self, ctx: Dict[str, Any], state) -> str:
        lines: List[str] = []

        # 局信息
        wind_names = ["东家", "南家", "西家", "北家"]
        scores = ctx["scores"]
        score_str = "  ".join(
            f"{self.player_names[i]}({wind_names[i]}) {scores[i]}" if scores else ""
            for i in range(4)
        )
        kyoku = ctx["kyoku"] or "?"
        lines.append(f"【局况】{kyoku} {ctx['honba']}本场  手牌数剩余 ~{max(0, 70 - ctx['tsumo_count'])}")
        lines.append(f"【分数】{score_str}")
        lines.append(f"【你】{self.player_names[self.seat]} (坐 {wind_names[self.seat]})")

        # 宝牌
        doras = [dora_of(m) for m in ctx["dora_markers"]]
        lines.append(f"【宝牌】指示牌 {ctx['dora_markers']} → 宝牌 {sorted(set(doras))}")

        # 我的手牌
        hand = hand_from_tehai(state.tehai, state.akas_in_hand)
        tsumo = state.last_self_tsumo()
        lines.append(
            f"【手牌】{' '.join(hand)}"
            + (f"  (刚摸 {tsumo})" if tsumo else "")
        )
        my_melds = ctx["melds"][self.seat]
        if my_melds:
            lines.append(f"【副露】{' | '.join(my_melds)}")
        lines.append(f"【牌效率】向听数={state.shanten}  听牌={'是' if state.shanten == 0 else '否'}"
                     + (f"  待牌={' '.join(_tiles_from_waits(state.waits))}" if state.shanten == 0 else ""))
        if state.at_furiten:
            lines.append("【振听】你在振听状态!(已振听时不能荣和)")

        # 各家的牌河与副露
        for i in range(4):
            if i == self.seat:
                continue
            kawa = ctx["kawa"][i]
            kawa_str = " ".join(kawa) if kawa else "-"
            riichi = " [立直]" if ctx["riichi"][i] else ""
            melds = " 副露:" + " ".join(ctx["melds"][i]) if ctx["melds"][i] else ""
            lines.append(
                f"【{self.player_names[i]}】{wind_names[i]}{riichi}{melds}  牌河: {kawa_str}"
            )

        # 合法动作
        legal = self._legal_desc(state)
        lines.append(f"【合法动作】{legal}")

        return "\n".join(lines)

    def _legal_desc(self, state) -> str:
        cans = state.last_cans
        opts: List[str] = []
        if cans.can_discard:
            opts.append("dahai 打牌(需指定手牌中的一张牌)")
        if cans.can_riichi:
            opts.append("reach 立直(声明后需再打一张)")
        if cans.can_chi_low or cans.can_chi_mid or cans.can_chi_high:
            opts.append("chi 吃(可吃)")
        if cans.can_pon:
            opts.append("pon 碰(可碰)")
        if cans.can_daiminkan:
            opts.append("daiminkan 大明杠")
        if cans.can_kakan:
            opts.append("kakan 加杠")
        if cans.can_ankan:
            opts.append("ankan 暗杠")
        if cans.can_tsumo_agari:
            opts.append("hora 自摸和牌")
        if cans.can_ron_agari:
            opts.append("hora 荣和")
        if cans.can_ryukyoku:
            opts.append("ryukyoku 流局")
        if any(("chi" in o) or ("pon" in o) or ("杠" in o) or ("荣和" in o) for o in opts):
            opts.append("pass 放弃鸣牌/荣和")
        return "; ".join(opts) if opts else "(无合法动作)"


def _tiles_from_waits(waits) -> List[str]:
    out = []
    for i, flag in enumerate(waits):
        if flag:
            out.append(TILE_NAME_BY_INDEX[i])
    return out


def render_game_state(game_state) -> str:
    """便捷入口:直接渲染一个 GameState。"""
    seat = game_state.game_index  # 调用方需确保 game_index == 座位
    return GameRenderer(seat).render(game_state)
