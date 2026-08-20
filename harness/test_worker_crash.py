"""Crash / isolation tests at protocol level (no Rust arena)."""

from __future__ import annotations

import unittest

from harness.worker import GameSession, Worker


class WorkerCrashTests(unittest.TestCase):
    def test_cancel_marks_cancelling_without_touching_others(self) -> None:
        worker = Worker()
        worker.sessions["a"] = GameSession(
            session_id="a", seed=1, model="mock", api_key="", base_url="",
            budget=0, use_mock=True, log_dir=None,  # type: ignore[arg-type]
        )
        worker.sessions["b"] = GameSession(
            session_id="b", seed=2, model="mock", api_key="", base_url="",
            budget=0, use_mock=True, log_dir=None,  # type: ignore[arg-type]
        )
        worker.sessions["a"].status = "running"
        worker.sessions["b"].status = "running"

        out = worker.handle({"id": "1", "method": "session.cancel", "params": {"sessionId": "a"}})
        self.assertEqual(out["result"]["status"], "cancelling")
        self.assertTrue(worker.sessions["a"].cancelled.is_set())
        self.assertFalse(worker.sessions["b"].cancelled.is_set())
        self.assertEqual(worker.sessions["b"].status, "running")

    def test_unknown_method_returns_error_object(self) -> None:
        worker = Worker()
        worker.sessions["s"] = GameSession(
            session_id="s", seed=7, model="mock", api_key="SECRET", base_url="",
            budget=0, use_mock=True, log_dir=None,  # type: ignore[arg-type]
        )
        out = worker.handle({"id": "x", "method": "session.explode", "params": {"sessionId": "s"}})
        self.assertIn("error", out)
        self.assertNotIn("SECRET", str(out))

    def test_snapshot_after_cancel_stays_serializable(self) -> None:
        session = GameSession(
            session_id="c", seed=3, model="mock", api_key="SECRET", base_url="",
            budget=0, use_mock=True, log_dir=None,  # type: ignore[arg-type]
        )
        session.cancelled.set()
        session.status = "cancelling"
        snap = session.snapshot()
        self.assertEqual(snap["status"], "cancelling")
        self.assertNotIn("SECRET", str(snap))


if __name__ == "__main__":
    unittest.main()
