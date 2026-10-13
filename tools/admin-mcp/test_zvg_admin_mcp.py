"""Runs the MCP server over stdio against a fake admin API (no network, no prod).

    uv run --with "mcp>=1.2,<2" --with httpx --with pytest --with anyio \
        pytest tools/admin-mcp
"""
from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import anyio
import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

SERVER = str(Path(__file__).with_name("zvg_admin_mcp.py"))
PASSWORD = "s3cret-pw"

LIVE = {"version": 5, "livingAreaSqm": 100, "heating": "Gas", "condition": {"a": 1}}
TRIAL = {"version": 6, "livingAreaSqm": 100, "heating": "Fernwaerme", "condition": {"a": 1}}
HISTORY = [
    {"id": "v6", "version": 6, "status": "success", "isLatest": False, "isTrial": True, "llmModel": "claude-sonnet-5-5"},
    {"id": "v5", "version": 5, "status": "success", "isLatest": True, "isTrial": False, "llmModel": "claude-haiku-5-5"},
]


class Fake(BaseHTTPRequestHandler):
    calls: list[tuple[str, str, object]] = []
    trial_started = False

    def log_message(self, *a):  # quiet
        pass

    def _json(self, code, payload):
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(n)) if n else None

    def _authed(self):
        return "settings_session=ok" in (self.headers.get("cookie") or "")

    def do_POST(self):
        body = self._body()
        Fake.calls.append(("POST", self.path, body))
        if self.path == "/api/settings/login":
            if (body or {}).get("password") != PASSWORD:
                return self._json(401, {"statusMessage": "Falsches Passwort."})
            data = b"{}"
            self.send_response(200)
            self.send_header("set-cookie", "settings_session=ok; Path=/")
            self.send_header("content-type", "application/json")
            self.send_header("content-length", "2")
            self.end_headers()
            return self.wfile.write(data)
        if not self._authed():
            return self._json(401, {"statusMessage": "Not authenticated."})
        if self.path.endswith("/reprocess") and "/auction/" in self.path:
            Fake.trial_started = True
            return self._json(200, {"started": True})
        return self._json(200, {"started": True})

    def do_PUT(self):
        Fake.calls.append(("PUT", self.path, self._body()))
        self._json(200, {"ok": True}) if self._authed() else self._json(401, {})

    def do_DELETE(self):
        Fake.calls.append(("DELETE", self.path, None))
        self._json(200, {"deleted": True}) if self._authed() else self._json(401, {})

    def do_GET(self):
        Fake.calls.append(("GET", self.path, None))
        if not self._authed():
            return self._json(401, {"statusMessage": "Not authenticated."})
        if self.path.endswith("/technical"):
            hist = HISTORY if Fake.trial_started else HISTORY[1:]
            return self._json(200, {"extractionHistory": hist})
        if self.path.endswith("/versions/5"):
            return self._json(200, LIVE)
        if self.path.endswith("/versions/6"):
            return self._json(200, TRIAL)
        if self.path.startswith("/api/settings/llm-profiles"):
            return self._json(200, {"profiles": [{"id": "p1", "name": "Sonnet"}], "assignments": {}, "strategy": "fallback"})
        self._json(200, {"path": self.path})


@pytest.fixture()
def fake():
    Fake.calls = []
    Fake.trial_started = False
    srv = HTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


async def session_run(base, fn, **env):
    child_env = os.environ.copy()
    child_env.pop("ZVG_ADMIN_PASSWORD_FILE", None)
    child_env.pop("ZVG_MCP_READONLY", None)
    child_env.update({"ZVG_BASE_URL": base, "ZVG_ADMIN_PASSWORD": PASSWORD, **env})
    params = StdioServerParameters(
        command=sys.executable, args=[SERVER],
        env=child_env,
    )
    async with stdio_client(params) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            return await fn(s)


def text(result):
    return result.content[0].text


def test_read_write_tools_and_diff(fake):
    Fake.trial_started = True  # trial row already exists

    async def go(s):
        names = {t.name for t in (await s.list_tools()).tools}
        diff = json.loads(text(await s.call_tool("compare_trial_to_live", {"platform": "kip", "external_id": "H1"})))
        bad = text(await s.call_tool("delete_trial_version", {"platform": "kip", "external_id": "H1", "version": 5}))
        ok = text(await s.call_tool("delete_trial_version", {"platform": "kip", "external_id": "H1", "version": 6}))
        return names, diff, bad, ok

    names, diff, bad, ok = anyio.run(lambda: session_run(fake, go))
    assert {"run_trial", "set_llm_kill_switch", "get_auction_technical"} <= names
    assert diff["changed"] == {"heating": {"a": "Gas", "b": "Fernwaerme"}}
    assert diff["trial"]["llmModel"] == "claude-sonnet-5-5"
    assert "verweigert" in bad
    assert '"deleted": true' in ok
    assert ("DELETE", "/api/settings/auction/kip/H1/versions/5", None) not in Fake.calls


def test_readonly_hides_write_tools(fake):
    async def go(s):
        return {t.name for t in (await s.list_tools()).tools}

    names = anyio.run(lambda: session_run(fake, go, ZVG_MCP_READONLY="1"))
    assert "get_operations" in names
    assert not names & {"run_trial", "set_llm_kill_switch", "set_llm_assignments", "start_reprocess", "delete_trial_version"}


def test_wrong_password_is_reported_without_leaking_it(fake):
    async def go(s):
        return text(await s.call_tool("get_operations", {}))

    msg = anyio.run(lambda: session_run(fake, go, ZVG_ADMIN_PASSWORD="nope"))
    assert "Passwort falsch" in msg and "nope" not in msg


def test_assignment_validation(fake):
    async def go(s):
        unknown = text(await s.call_tool("set_llm_assignments", {"extraction": ["x"], "translation": []}))
        strat = text(await s.call_tool("set_llm_assignments", {"extraction": ["p1"], "translation": [], "strategy": "bogus"}))
        ok = text(await s.call_tool("set_llm_assignments", {"extraction": ["p1"], "translation": ["p1"], "strategy": "round-robin"}))
        return unknown, strat, ok

    unknown, strat, ok = anyio.run(lambda: session_run(fake, go))
    assert "unbekannte Profil-IDs" in unknown and "strategy muss" in strat
    assert '"ok": true' in ok
    puts = [c for c in Fake.calls if c[0] == "PUT"]
    assert puts == [("PUT", "/api/settings/llm-assignments", {"assignments": {"extraction": ["p1"], "translation": ["p1"]}, "strategy": "round-robin"})]


def test_run_trial_waits_for_the_new_trial_row(fake, monkeypatch, tmp_path):
    async def go(s):
        return text(await s.call_tool("run_trial", {"platform": "kip", "external_id": "H1", "profile_id": "p1", "wait_seconds": 20}))

    password_file = tmp_path / "wrong-password"
    password_file.write_text("wrong", encoding="utf-8")
    monkeypatch.setenv("ZVG_ADMIN_PASSWORD_FILE", str(password_file))
    monkeypatch.setenv("ZVG_MCP_READONLY", "1")
    res = json.loads(anyio.run(lambda: session_run(fake, go)))
    assert res["status"] == "success" and res["llmModel"] == "claude-sonnet-5-5"
    posts = [c for c in Fake.calls if c[0] == "POST" and c[1].endswith("/reprocess")]
    assert posts == [("POST", "/api/settings/auction/kip/H1/reprocess", {"profileId": "p1"})]
