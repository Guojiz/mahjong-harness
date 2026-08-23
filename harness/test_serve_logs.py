"""Security-focused tests for the loopback MJAI viewer server."""

from __future__ import annotations

import json
import unittest

from harness.serve_logs import script_json, valid_session_id


class ServeLogsTests(unittest.TestCase):
    def test_session_id_rejects_path_traversal_and_encoded_slashes(self) -> None:
        self.assertEqual(valid_session_id("mj-safe_123"), "mj-safe_123")
        self.assertIsNone(valid_session_id("../private"))
        self.assertIsNone(valid_session_id("mj%2Fprivate"))
        self.assertIsNone(valid_session_id(""))

    def test_inline_json_cannot_break_out_of_script(self) -> None:
        encoded = script_json([{"type": "note", "text": "</script><script>alert(1)</script>"}])
        self.assertNotIn("<", encoded)
        self.assertNotIn(">", encoded)
        self.assertEqual(json.loads(encoded), [{"type": "note", "text": "</script><script>alert(1)</script>"}])


if __name__ == "__main__":
    unittest.main()
