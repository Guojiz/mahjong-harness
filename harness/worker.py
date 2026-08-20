"""Long-lived JSONL worker for DSH mahjong sessions.

stdin and stdout are exclusively protocol transport. Diagnostic messages use
stderr, and each game session runs on its own daemon thread so the controller
can continue receiving status, cancel, and export requests.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

MORTAL_PY_DIR = Path(__file__).resolve().parent.parent / "Mortal" / "mortal"
sys.path.insert(0, str(MORTAL_PY_DIR))

from libriichi.arena import OneVsThree  # noqa: E402

from harness.engines import RuleEngine  # noqa: E402
from harness.llm_engine import LLMEngine, MockLLMClient, OpenAICompatibleClient  # noqa: E402


_WRITE_LOCK = threading.Lock()


def emit(payload: dict[str, Any]) -> None:
    """Write one protocol frame without exposing prompts or credentials."""
    with _WRITE_LOCK:
        print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def event_list(events_json: Any) -> list[dict[str, Any]]:
    if isinstance(events_json, str):
        try:
            events_json = json.loads(events_json)
        except json.JSONDecodeError:
            return []
    if not isinstance(events_json, list):
        return []
    return [event for event in events_json if isinstance(event, dict)]


class EventingLLMEngine(LLMEngine):
    """LLM engine that publishes the authoritative MJAI stream observed by it."""

    def __init__(self, *args: Any, session: "GameSession", **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._session = session
        self._seen_events = 0

    def react_one(self, game_state: Any) -> str:
        events = event_list(game_state.events_json)
        if len(events) < self._seen_events:
            self._seen_events = 0
        for event in events[self._seen_events:]:
            self._session.publish_mjai(event)
        self._seen_events = len(events)
        if self._session.cancelled.is_set():
            # The arena accepts a legal no-op at reaction boundaries. It cannot
            # interrupt a currently blocking external HTTP request.
            return json.dumps({"type": "none"})
        before_violations = self.violations
        before_delegated = self.delegated
        started = time.monotonic()
        result = super().react_one(game_state)
        self._session.publish_decision({
            "status": "fallback" if self.violations > before_violations or self.delegated > before_delegated else "accepted",
            "latencyMs": int((time.monotonic() - started) * 1000),
            "violations": self.violations,
            "fallbacks": self.delegated,
        })
        return result


@dataclass
class GameSession:
    session_id: str
    seed: int
    model: str
    api_key: str
    base_url: str
    budget: int | None
    use_mock: bool
    log_dir: Path
    cancelled: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)
    status: str = "starting"
    seq: int = 0
    events: list[dict[str, Any]] = field(default_factory=list)
    scores: list[int] = field(default_factory=lambda: [25000, 25000, 25000, 25000])
    error: str | None = None
    violations: int = 0
    fallbacks: int = 0
    llm_calls: int = 0
    elapsed_ms: int = 0

    def snapshot(self, include_events: bool = False) -> dict[str, Any]:
        with self.lock:
            result: dict[str, Any] = {
                "sessionId": self.session_id,
                "status": self.status,
                "seed": self.seed,
                "model": self.model,
                "scores": list(self.scores),
                "lastEvent": self.events[-1] if self.events else None,
                "eventCount": len(self.events),
                "violations": self.violations,
                "fallbacks": self.fallbacks,
                "llmCalls": self.llm_calls,
                "elapsedMs": self.elapsed_ms,
                "error": self.error,
            }
            if include_events:
                result["events"] = list(self.events)
            return result

    def publish_mjai(self, event: dict[str, Any]) -> None:
        with self.lock:
            self.seq += 1
            self.events.append(event)
            if isinstance(event.get("scores"), list) and len(event["scores"]) == 4:
                self.scores = [int(score) for score in event["scores"]]
            seq = self.seq
        emit({"event": "mjai", "sessionId": self.session_id, "seq": seq, "data": event})

    def publish_decision(self, data: dict[str, Any]) -> None:
        with self.lock:
            self.seq += 1
            seq = self.seq
        emit({"event": "decision", "sessionId": self.session_id, "seq": seq, "data": data})

    def publish_state(self) -> None:
        emit({"event": "session", "sessionId": self.session_id, "data": self.snapshot()})

    def run(self) -> None:
        started = time.monotonic()
        try:
            with self.lock:
                self.status = "running"
            self.publish_state()
            if self.use_mock or not self.api_key:
                client = MockLLMClient(seed=self.seed)
                client_name = "mock"
            else:
                client = OpenAICompatibleClient(
                    api_key=self.api_key,
                    base_url=self.base_url,
                    model=self.model,
                    timeout=45.0,
                    retries=1,
                )
                client_name = self.model
            llm = EventingLLMEngine(
                client=client,
                name=client_name,
                max_decisions=self.budget,
                skip_call_decisions=True,
                progress_every=0,
                session=self,
            )
            try:
                self.log_dir.mkdir(parents=True, exist_ok=True)
                active_log_dir = self.log_dir
            except OSError as error:
                # Some DSH sandbox profiles allow writes only under an existing
                # workspace log root. Keep the session isolated in memory and
                # continue the authoritative rules run without creating a new
                # directory that the child cannot access.
                print(f"log directory unavailable for {self.session_id}: {error}", file=sys.stderr, flush=True)
                active_log_dir = self.log_dir.parent
            arena = OneVsThree(disable_progress_bar=True, log_dir=str(active_log_dir))
            rankings = arena.py_vs_py(
                challenger=llm,
                champion=RuleEngine("rule-champion"),
                seed_start=(self.seed, 0),
                seed_count=1,
            )
            with self.lock:
                self.violations = llm.violations
                self.fallbacks = llm.delegated
                self.llm_calls = llm.llm_calls
                if llm.game_results:
                    self.scores = list(llm.game_results[-1]["scores"])
                self.status = "cancelled" if self.cancelled.is_set() else "ended"
            self.publish_decision({"status": "complete", "rankings": list(rankings)})
        except Exception as error:  # noqa: BLE001
            print(f"worker session {self.session_id} failed: {error}", file=sys.stderr, flush=True)
            traceback.print_exc(file=sys.stderr)
            with self.lock:
                self.status = "failed"
                self.error = str(error)[:500]
        finally:
            with self.lock:
                self.elapsed_ms = int((time.monotonic() - started) * 1000)
            self.publish_state()


class Worker:
    def __init__(self) -> None:
        self.sessions: dict[str, GameSession] = {}
        self.lock = threading.Lock()

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        request_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        if not isinstance(request_id, str) or not isinstance(method, str) or not isinstance(params, dict):
            return {"id": request_id, "error": {"message": "invalid request"}}
        try:
            if method == "session.start":
                session_id = params.get("sessionId")
                if not isinstance(session_id, str) or not session_id:
                    raise ValueError("sessionId is required")
                with self.lock:
                    if session_id in self.sessions:
                        raise ValueError("sessionId already exists")
                    session = GameSession(
                        session_id=session_id,
                        seed=int(params.get("seed", 7)),
                        model=str(params.get("model", "deepseek-ai/DeepSeek-V4-Flash")),
                        api_key=str(params.get("apiKey", "")),
                        base_url=str(params.get("baseUrl", "https://api.siliconflow.cn/v1")),
                        budget=int(params["budget"]) if params.get("budget") is not None else None,
                        use_mock=bool(params.get("mock", False)),
                        log_dir=Path(params.get("logDir", "logs/dsh")) / session_id,
                    )
                    self.sessions[session_id] = session
                thread = threading.Thread(target=session.run, name=f"mahjong-{session_id}", daemon=True)
                thread.start()
                return {"id": request_id, "result": session.snapshot()}
            session_id = params.get("sessionId")
            if not isinstance(session_id, str):
                raise ValueError("sessionId is required")
            with self.lock:
                session = self.sessions.get(session_id)
            if session is None:
                raise ValueError("unknown sessionId")
            if method == "session.status":
                return {"id": request_id, "result": session.snapshot()}
            if method == "session.export":
                return {"id": request_id, "result": session.snapshot(include_events=True)}
            if method == "session.cancel":
                session.cancelled.set()
                with session.lock:
                    if session.status in {"starting", "running"}:
                        session.status = "cancelling"
                session.publish_state()
                return {"id": request_id, "result": session.snapshot()}
            raise ValueError(f"unknown method: {method}")
        except Exception as error:  # noqa: BLE001
            return {"id": request_id, "error": {"message": str(error)[:500]}}


def main() -> int:
    worker = Worker()
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            emit({"id": None, "error": {"message": "invalid JSON"}})
            continue
        if not isinstance(request, dict):
            emit({"id": None, "error": {"message": "request must be an object"}})
            continue
        emit(worker.handle(request))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
