"""Tests for the OpenAI-compatible streaming response parser."""

from __future__ import annotations

import unittest
import threading

from harness.llm_engine import OpenAICompatibleClient


class LLMClientTests(unittest.TestCase):
    def test_stream_joins_content_and_ignores_reasoning(self) -> None:
        client = OpenAICompatibleClient(api_key="test", stream=True)
        lines = [
            b'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n',
            b'data: {"choices":[{"delta":{"content":"{\\"action\\":"}}]}\n',
            b'data: {"choices":[{"delta":{"content":"\\"pass\\"}"}}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n',
            b"data: [DONE]\n",
        ]
        self.assertEqual(client._read_stream(lines), '{"action":"pass"}')
        self.assertEqual(client.usage_total["total_tokens"], 6)

    def test_stream_without_content_fails_clearly(self) -> None:
        client = OpenAICompatibleClient(api_key="test", stream=True)
        with self.assertRaisesRegex(RuntimeError, "没有 content"):
            client._read_stream([b"data: [DONE]\n"])

    def test_stream_total_timeout_is_bounded(self) -> None:
        client = OpenAICompatibleClient(api_key="test", stream=True, total_timeout=0)
        with self.assertRaisesRegex(TimeoutError, "超过总时限"):
            client._read_stream([b'data: {"choices":[{"delta":{"content":"x"}}]}\n'])

    def test_cancelled_stream_fails_before_consuming_content(self) -> None:
        cancelled = threading.Event()
        cancelled.set()
        client = OpenAICompatibleClient(api_key="test", cancel_event=cancelled)
        with self.assertRaisesRegex(RuntimeError, "已取消"):
            client._read_stream([b'data: {"choices":[{"delta":{"content":"x"}}]}\n'])


if __name__ == "__main__":
    unittest.main()
