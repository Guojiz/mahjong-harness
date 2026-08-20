"""Protocol-level tests that do not start the Rust arena or write game logs."""

from __future__ import annotations

import json
import unittest

from harness.worker import GameSession, Worker, event_list


class WorkerProtocolTests(unittest.TestCase):
    def test_event_list_rejects_malformed_values(self) -> None:
        self.assertEqual(event_list("not json"), [])
        self.assertEqual(event_list({"type": "dahai"}), [])
        self.assertEqual(event_list('[{"type":"tsumo"}]'), [{"type": "tsumo"}])

    def test_request_validation_and_session_isolation(self) -> None:
        worker = Worker()
        invalid = worker.handle({"id": "bad", "method": "session.status", "params": {}})
        self.assertIn("sessionId is required", invalid["error"]["message"])
        unknown = worker.handle({"id": "unknown", "method": "session.status", "params": {"sessionId": "missing"}})
        self.assertIn("unknown sessionId", unknown["error"]["message"])

        worker.sessions["s1"] = GameSession(
            session_id="s1", seed=7, model="mock", api_key="", base_url="", budget=0,
            use_mock=True, log_dir=None,  # type: ignore[arg-type]
        )
        worker.sessions["s2"] = GameSession(
            session_id="s2", seed=8, model="mock", api_key="", base_url="", budget=0,
            use_mock=True, log_dir=None,  # type: ignore[arg-type]
        )
        response = worker.handle({"id": "cancel", "method": "session.cancel", "params": {"sessionId": "s1"}})
        self.assertEqual(response["result"]["status"], "cancelling")
        self.assertTrue(worker.sessions["s1"].cancelled.is_set())
        self.assertFalse(worker.sessions["s2"].cancelled.is_set())

    def test_snapshot_has_no_secret_or_prompt_fields(self) -> None:
        session = GameSession(
            session_id="s", seed=7, model="mock", api_key="SECRET", base_url="https://example.invalid",
            budget=0, use_mock=True, log_dir=None,  # type: ignore[arg-type]
        )
        snapshot = session.snapshot()
        encoded = json.dumps(snapshot, ensure_ascii=False)
        self.assertNotIn("SECRET", encoded)
        self.assertNotIn("prompt", encoded.lower())
        self.assertNotIn("api_key", encoded.lower())


if __name__ == "__main__":
    unittest.main()
