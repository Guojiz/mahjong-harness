"""Simple HTTP server for the MJAI log-viewer with session events.

Serves dsh-plugin/log-viewer/ as static files and exposes API endpoints
so the DSH client can iframe to a fully rendered replay.

Usage:
    python3 -m harness.serve_logs [--port 8765] [--host 127.0.0.1]

The worker writes session state to <log-dir>/<sessionId>/state.json
and mjai events to <log-dir>/<sessionId>/events.jsonl on each publish.
"""

from __future__ import annotations

import argparse
import json
import re
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

_LOG_VIEWER_DIR = Path(__file__).resolve().parent.parent / "dsh-plugin" / "log-viewer"
_DEFAULT_LOG_DIR = Path(__file__).resolve().parent.parent / "logs" / "dsh"
# In-memory session store shared with worker (injected at startup)
_SESSIONS: dict[str, dict[str, Any]] = {}
# Mutable container for runtime log_dir override
_log_dir_ref: list[Path] = [_DEFAULT_LOG_DIR]
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")


def valid_session_id(value: str) -> str | None:
    value = unquote(value)
    return value if _SESSION_ID_RE.fullmatch(value) else None


def script_json(value: Any) -> str:
    """Serialize JSON for an inline script without permitting tag breakout."""
    return (
        json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        .replace("&", "\\u0026")
        .replace("<", "\\u003c")
        .replace(">", "\\u003e")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


class MJAIHandler(SimpleHTTPRequestHandler):
    """Serve log-viewer static files + session-event API."""

    server_version = "mahjong-harness-log-server"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        # Serve from log-viewer directory for static files
        super().__init__(*args, directory=str(_LOG_VIEWER_DIR), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        """Suppress default stderr logging."""
        pass

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        # API: serve session events as JSON
        if path.startswith("/api/events/"):
            session_id = valid_session_id(path.removeprefix("/api/events/").strip("/"))
            if session_id is None:
                self.send_error(400, "invalid session id")
                return
            self._serve_events(session_id)
            return
        # API: serve session state snapshot
        if path.startswith("/api/state/"):
            session_id = valid_session_id(path.removeprefix("/api/state/").strip("/"))
            if session_id is None:
                self.send_error(400, "invalid session id")
                return
            self._serve_state(session_id)
            return
        # API: serve log-viewer HTML with events injected
        if path.startswith("/view/"):
            session_id = valid_session_id(path.removeprefix("/view/").strip("/"))
            if session_id is None:
                self.send_error(400, "invalid session id")
                return
            self._serve_view(session_id)
            return
        # Otherwise serve static files from log-viewer directory
        if path == "/" or path == "":
            self.path = "/index.html"
        super().do_GET()

    def _serve_json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_events(self, session_id: str) -> None:
        # Try log file first, then in-memory store
        events: list[dict[str, Any]] = []
        log_file = _log_dir_ref[0] / session_id / "events.jsonl"
        if log_file.exists():
            try:
                with open(log_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            try:
                                events.append(json.loads(line))
                            except json.JSONDecodeError:
                                pass
            except OSError:
                pass
        if not events and session_id in _SESSIONS:
            events = _SESSIONS[session_id].get("events", [])
        self._serve_json(events)

    def _serve_state(self, session_id: str) -> None:
        state_file = _log_dir_ref[0] / session_id / "state.json"
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self._serve_json({"error": "session not found", "sessionId": session_id}, status=404)
            return
        if not isinstance(state, dict):
            self._serve_json({"error": "invalid state", "sessionId": session_id}, status=500)
            return
        state.pop("api_key", None)
        state.pop("apiKey", None)
        self._serve_json(state)

    def _serve_view(self, session_id: str) -> None:
        """Return the log-viewer HTML with the session events embedded."""
        index_path = _LOG_VIEWER_DIR / "index.html"
        try:
            html = index_path.read_text(encoding="utf-8")
        except OSError:
            self.send_error(500, "Cannot read log-viewer/index.html")
            return

        # Build event injection script
        events_list: list[dict[str, Any]] = []
        log_file = _log_dir_ref[0] / session_id / "events.jsonl"
        if log_file.exists():
            try:
                with open(log_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line:
                            try:
                                events_list.append(json.loads(line))
                            except json.JSONDecodeError:
                                pass
            except OSError:
                pass

        events_json = script_json(events_list)
        session_json = script_json(session_id)
        inject_script = (
            f"<script>window.__INJECTED_EVENTS__ = {events_json};"
            f"window.__SESSION_ID__ = {session_json};"
            f"window.addEventListener('DOMContentLoaded', function() {{"
            f"  var count = -1;"
            f"  function render(events) {{"
            f"    if (!Array.isArray(events) || events.length === count || !window.MJAIStudio) return;"
            f"    count = events.length;"
            f"    window.MJAIStudio.loadEvents(events, 'Session ' + window.__SESSION_ID__);"
            f"  }}"
            f"  render(window.__INJECTED_EVENTS__);"
            f"  window.setInterval(function() {{"
            f"    fetch('/api/events/' + encodeURIComponent(window.__SESSION_ID__), {{cache:'no-store'}})"
            f"      .then(function(r) {{ return r.ok ? r.json() : []; }})"
            f"      .then(render).catch(function() {{}});"
            f"  }}, 1500);"
            f"}});</script>"
        )

        # Insert before closing </body>
        html = html.replace("</body>", inject_script + "\n</body>")

        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    ap = argparse.ArgumentParser(description="MJAI log-viewer HTTP server")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--session-dir", default=str(_log_dir_ref[0]))
    args = ap.parse_args()

    _log_dir_ref[0] = Path(args.session_dir)
    _log_dir_ref[0].mkdir(parents=True, exist_ok=True)

    server = HTTPServer((args.host, args.port), MJAIHandler)
    print(f"MJAI log server: http://{args.host}:{args.port}", flush=True)
    print(f"Log viewer:      http://{args.host}:{args.port}/index.html", flush=True)
    print(f"View session:    http://{args.host}:{args.port}/view/<sessionId>", flush=True)
    print(f"Events API:      http://{args.host}:{args.port}/api/events/<sessionId>", flush=True)
    print("Press Ctrl-C to stop.", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
