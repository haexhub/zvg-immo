#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp>=1.2,<2", "httpx>=0.27"]
# ///
"""MCP server for the zvg-immo admin API (/api/settings/*).

Runs locally over stdio. It logs in with the settings password the same way
the /settings page does and keeps the session cookie inside this process, so
the password never reaches the model. Only the curated tools below are
exposed; there is deliberately no generic "call any endpoint" tool.

Environment:
  ZVG_BASE_URL             default https://zvg.haex.cloud
  ZVG_ADMIN_PASSWORD       the settings password, or
  ZVG_ADMIN_PASSWORD_FILE  path to a file holding it (preferred, chmod 600)
  ZVG_MCP_READONLY=1       register read tools only
"""
from __future__ import annotations

import functools
import json
import os
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

BASE_URL = os.environ.get("ZVG_BASE_URL", "https://zvg.haex.cloud").rstrip("/")
READONLY = os.environ.get("ZVG_MCP_READONLY") == "1"
MAX_RESULT_CHARS = 24_000
CHAIN_STRATEGIES = ("fallback", "round-robin")
_TRIAL_LOCKS = {}
_TRIAL_LOCKS_GUARD = threading.Lock()

# Fields of GET .../versions/{n} that are worth diffing (see
# server/api/settings/auction/[platform]/[id]/versions/[version].get.ts).
DIFF_IGNORE = {"version"}


class AdminError(Exception):
    """A failure the model should see verbatim (never contains secrets)."""


def _password() -> str:
    path = os.environ.get("ZVG_ADMIN_PASSWORD_FILE")
    if path:
        try:
            value = Path(path).expanduser().read_text(encoding="utf-8").strip()
        except OSError as e:
            raise AdminError(f"ZVG_ADMIN_PASSWORD_FILE nicht lesbar: {e.strerror}") from None
        if value:
            return value
    value = os.environ.get("ZVG_ADMIN_PASSWORD", "").strip()
    if not value:
        raise AdminError("Kein Passwort konfiguriert: ZVG_ADMIN_PASSWORD_FILE oder ZVG_ADMIN_PASSWORD setzen.")
    return value


class Admin:
    """Thin session wrapper: lazy login, one re-login on 401."""

    def __init__(self) -> None:
        self._http = httpx.Client(base_url=BASE_URL, timeout=60.0, follow_redirects=False)
        self._logged_in = False

    def _login(self) -> None:
        r = self._http.post("/api/settings/login", json={"password": _password()})
        if r.status_code == 429:
            raise AdminError("Login rate-limitiert (zu viele Fehlversuche) - 60 s warten.")
        if r.status_code == 401:
            raise AdminError("Login abgelehnt: Passwort falsch.")
        if r.status_code >= 400:
            raise AdminError(f"Login fehlgeschlagen: HTTP {r.status_code}")
        self._logged_in = True

    def request(self, method: str, path: str, *, params: dict | None = None, body: Any = None) -> Any:
        for attempt in (1, 2):
            if not self._logged_in:
                self._login()
            r = self._http.request(method, path, params=params, json=body)
            if r.status_code == 401 and attempt == 1:
                self._logged_in = False
                continue
            break
        if r.status_code >= 400:
            try:
                msg = r.json().get("statusMessage") or ""
            except Exception:
                msg = ""
            raise AdminError(f"HTTP {r.status_code} bei {method} {path}: {msg}".strip())
        if not r.content:
            return {}
        try:
            return r.json()
        except ValueError:
            raise AdminError(f"Antwort von {path} ist kein JSON.") from None


admin = Admin()


def seg(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def auction_path(platform: str, external_id: str) -> str:
    return f"/api/settings/auction/{seg(platform)}/{seg(external_id)}"


def out(data: Any) -> str:
    text = json.dumps(data, ensure_ascii=False, indent=2, default=str)
    if len(text) > MAX_RESULT_CHARS:
        return text[:MAX_RESULT_CHARS] + f"\n... [gekuerzt, {len(text)} Zeichen insgesamt]"
    return text


def short(value: Any, limit: int = 600) -> Any:
    if isinstance(value, (dict, list)):
        text = json.dumps(value, ensure_ascii=False, default=str)
        return text if len(text) <= limit else text[:limit] + "..."
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + "..."
    return value


def diff_versions(a: dict, b: dict) -> dict[str, Any]:
    changed: dict[str, Any] = {}
    for key in sorted(set(a) | set(b)):
        if key in DIFF_IGNORE:
            continue
        if a.get(key) != b.get(key):
            changed[key] = {"a": short(a.get(key)), "b": short(b.get(key))}
    return changed


READ = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False, openWorldHint=False)

mcp = FastMCP("zvg-admin")


def tool(annotations: ToolAnnotations, *, write: bool = False):
    """Registers a tool; write tools vanish when ZVG_MCP_READONLY=1."""

    def deco(fn):
        if write and READONLY:
            return fn
        return mcp.tool(annotations=annotations)(fn)

    return deco


def guarded(fn):
    """Turns AdminError into a readable tool result instead of a stack trace."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except AdminError as e:
            return f"FEHLER: {e}"
        except httpx.HTTPError as e:
            return f"FEHLER: Netzwerk ({type(e).__name__})"

    return wrapper


# ── Lesen ────────────────────────────────────────────────────────────────────


@tool(READ)
@guarded
def get_operations() -> str:
    """App-Laufzeitstatus und Host-Jobs (Crawl, Backups, OSM-Import ...) samt Fehlern."""
    return out(admin.request("GET", "/api/settings/operations"))


@tool(READ)
@guarded
def get_llm_overview() -> str:
    """Pro Land: wie viele Auktionen LLM-extrahiert sind (done/error/open/pending)."""
    return out(admin.request("GET", "/api/settings/llm-status"))


@tool(READ)
@guarded
def list_llm_profiles() -> str:
    """LLM-Profile (ohne API-Keys), Zuweisungen je Zweck, Ketten-Strategie. Hier stehen die Profil-IDs fuer run_trial."""
    return out(admin.request("GET", "/api/settings/llm-profiles"))


@tool(READ)
@guarded
def get_llm_kill_switch() -> str:
    """Ob die LLM-Kette per Kill-Switch abgeschaltet ist."""
    return out(admin.request("GET", "/api/settings/llm-kill-switch"))


@tool(READ)
@guarded
def get_llm_costs(days: int = 30) -> str:
    """Token- und Kostenuebersicht aus llm_usage_events (1-90 Tage)."""
    return out(admin.request("GET", "/api/settings/llm-costs", params={"days": max(1, min(90, days))}))


@tool(READ)
@guarded
def get_llm_jobs() -> str:
    """Laufende/letzte Hintergrund-Jobs (Reprocess, Enrich, Batch) mit Status und Fehlern."""
    return out(admin.request("GET", "/api/settings/llm-batch-jobs"))


@tool(READ)
@guarded
def list_locked_auctions(country: str, limit: int = 50, offset: int = 0, search: str | None = None) -> str:
    """Fuer die LLM-Pipeline gesperrte Auktionen eines Landes (>= 3 Fehlversuche, keine erfolgreiche Extraktion) mit Fehlerzaehler und letzter Fehlermeldung. country: ISO-2 (de, bg, se). limit 1-200."""
    params: dict[str, Any] = {"bucket": "error", "limit": max(1, min(200, limit)), "offset": max(0, offset)}
    if search:
        params["search"] = search
    return out(admin.request("GET", f"/api/settings/llm-status/{seg(country.lower())}", params=params))


@tool(READ)
@guarded
def get_auction_technical(platform: str, external_id: str) -> str:
    """Technikseite einer Auktion: Fetch-Status, Dokumente, Extraktionshistorie (Versionen, Modelle, Kosten, Fehler)."""
    return out(admin.request("GET", auction_path(platform, external_id) + "/technical"))


@tool(READ)
@guarded
def get_auction_version(platform: str, external_id: str, version: int) -> str:
    """Alle Feldwerte einer Extraktionsversion."""
    return out(admin.request("GET", f"{auction_path(platform, external_id)}/versions/{int(version)}"))


@tool(READ)
@guarded
def compare_auction_versions(platform: str, external_id: str, version_a: int, version_b: int) -> str:
    """Feldweiser Diff zweier Versionen (nur abweichende Felder, a vs. b)."""
    base = auction_path(platform, external_id)
    a = admin.request("GET", f"{base}/versions/{int(version_a)}")
    b = admin.request("GET", f"{base}/versions/{int(version_b)}")
    return out({"version_a": version_a, "version_b": version_b, "changed": diff_versions(a, b)})


@tool(READ)
@guarded
def compare_trial_to_live(platform: str, external_id: str, trial_model: str | None = None) -> str:
    """Diff der neuesten erfolgreichen Trial-Version gegen die Live-Version. Mit trial_model (z.B. 'claude-sonnet-5-5') nur Trials dieses Modells."""
    base = auction_path(platform, external_id)
    history = admin.request("GET", base + "/technical").get("extractionHistory", [])
    live = next((r for r in history if r.get("isLatest") and not r.get("isTrial") and r.get("status") == "success"), None)
    trials = [
        r for r in history
        if r.get("isTrial") and r.get("status") == "success" and r.get("version") is not None
        and (not trial_model or r.get("llmModel") == trial_model)
    ]
    if not live or live.get("version") is None:
        return "FEHLER: keine Live-Version gefunden."
    if not trials:
        return f"FEHLER: keine erfolgreiche Trial-Version{' fuer ' + trial_model if trial_model else ''} gefunden."
    trial = max(trials, key=lambda r: r["version"])
    a = admin.request("GET", f"{base}/versions/{live['version']}")
    b = admin.request("GET", f"{base}/versions/{trial['version']}")
    meta = lambda r: {k: r.get(k) for k in ("version", "llmModel", "llmProvider", "llmCostUsd", "llmOutputTokens", "llmDurationMs", "createdAt")}
    return out({"live": meta(live), "trial": meta(trial), "changed": diff_versions(a, b)})


# ── Probelauf (schreibt nur Trial-Versionen, nie die Live-Daten) ─────────────


@tool(WRITE, write=True)
@guarded
def run_trial(platform: str, external_id: str, profile_id: str, wait_seconds: int = 240) -> str:
    """Startet eine Probe-Extraktion mit einem LLM-Profil und wartet auf das Ergebnis. Schreibt nur eine Trial-Version, die Live-Version bleibt unveraendert. Verbraucht LLM-Kontingent."""
    base = auction_path(platform, external_id)
    # The API currently returns only {started: true}, so the new row cannot be
    # correlated with a request ID. Serialize trials per auction until the API
    # exposes one; keeping the locks process-local is sufficient because this
    # stdio server owns the calls from its MCP client.
    with _TRIAL_LOCKS_GUARD:
        trial_lock = _TRIAL_LOCKS.setdefault(base, threading.Lock())
    with trial_lock:
        baseline = {r["id"] for r in admin.request("GET", base + "/technical").get("extractionHistory", [])}
        admin.request("POST", base + "/reprocess", body={"profileId": profile_id})
        deadline = time.time() + max(10, min(600, wait_seconds))
        while time.time() < deadline:
            time.sleep(5)
            history = admin.request("GET", base + "/technical").get("extractionHistory", [])
            new = [r for r in history if r.get("isTrial") and r["id"] not in baseline and r.get("status") != "pending"]
            if new:
                r = new[0]
                keys = ("status", "version", "llmModel", "llmCostUsd", "llmInputTokens", "llmOutputTokens", "llmDurationMs", "errorMessage")
                return out({k: r.get(k) for k in keys})
        return "Noch kein Ergebnis nach der Wartezeit - der Lauf kann trotzdem noch fertig werden (get_auction_technical)."


@tool(DESTRUCTIVE, write=True)
@guarded
def delete_trial_version(platform: str, external_id: str, version: int) -> str:
    """Loescht eine Trial-Version (nur Trials; Live- und normale Versionen werden abgelehnt)."""
    base = auction_path(platform, external_id)
    history = admin.request("GET", base + "/technical").get("extractionHistory", [])
    row = next((r for r in history if r.get("version") == int(version)), None)
    if row is None:
        return f"FEHLER: Version {version} nicht gefunden."
    if not row.get("isTrial") or row.get("isLatest"):
        return f"FEHLER: Version {version} ist keine Trial-Version - verweigert."
    return out(admin.request("DELETE", f"{base}/versions/{int(version)}"))


# ── Konfiguration (wirkt auf den Live-Betrieb) ───────────────────────────────


@tool(DESTRUCTIVE, write=True)
@guarded
def set_llm_kill_switch(enabled: bool) -> str:
    """Schaltet die LLM-Kette ab (true) oder an (false). Wirkt sofort; bereits eingereichte Batch-Jobs laufen weiter."""
    return out(admin.request("PUT", "/api/settings/llm-kill-switch", body={"enabled": bool(enabled)}))


@tool(DESTRUCTIVE, write=True)
@guarded
def set_llm_assignments(extraction: list[str], translation: list[str], strategy: str | None = None) -> str:
    """Weist LLM-Profile (IDs aus list_llm_profiles) den Zwecken zu. Die Reihenfolge ist die Fallback-Reihenfolge. strategy: 'fallback' oder 'round-robin' (nur Extraktion). Ersetzt die komplette Zuweisung."""
    if strategy is not None and strategy not in CHAIN_STRATEGIES:
        return f"FEHLER: strategy muss {' oder '.join(CHAIN_STRATEGIES)} sein."
    known = {p["id"] for p in admin.request("GET", "/api/settings/llm-profiles").get("profiles", [])}
    unknown = [i for i in (*extraction, *translation) if i not in known]
    if unknown:
        return f"FEHLER: unbekannte Profil-IDs: {', '.join(unknown)}"
    body: dict[str, Any] = {"assignments": {"extraction": extraction, "translation": translation}}
    if strategy:
        body["strategy"] = strategy
    return out(admin.request("PUT", "/api/settings/llm-assignments", body=body))


@tool(DESTRUCTIVE, write=True)
@guarded
def retry_locked_auctions(limit: int, country: str | None = None, platform: str | None = None) -> str:
    """Versucht gesperrte Auktionen (>= 3 Fehlversuche, keine erfolgreiche Extraktion) erneut mit der zugewiesenen LLM-Kette. Schreibt neue LIVE-Versionen und verbraucht LLM-Kontingent. limit 1-200; die am laengsten nicht versuchten kommen zuerst, wiederholte Laeufe arbeiten also die ganze Sperrliste ab. Ein neuer manueller Reprocess ersetzt einen laufenden - deshalb wird abgelehnt, solange einer laeuft. Fortschritt ueber get_llm_jobs."""
    if not 1 <= limit <= 200:
        return "FEHLER: limit muss zwischen 1 und 200 liegen."
    status = (admin.request("GET", "/api/settings/llm-batch-jobs").get("reprocessStatus") or {}).get("status")
    if status == "running":
        return "ABGELEHNT: Es laeuft bereits ein Reprocess (get_llm_jobs). Ein neuer manueller Lauf wuerde ihn ersetzen - erst abwarten."
    body: dict[str, Any] = {"limit": limit, "retryFailed": True}
    if country:
        body["country"] = country.lower()
    if platform:
        body["platform"] = platform
    return out(admin.request("POST", "/api/settings/reprocess", body=body))


@tool(DESTRUCTIVE, write=True)
@guarded
def retry_auction_llm(platform: str, external_id: str) -> str:
    """Erzwingt die LLM-Extraktion fuer genau eine Auktion mit der zugewiesenen Kette (auch wenn sie nicht gesperrt ist). Schreibt eine neue LIVE-Version. Laeuft im Hintergrund; Ergebnis ueber get_auction_technical."""
    return out(admin.request("POST", auction_path(platform, external_id) + "/reprocess-retry"))


@tool(DESTRUCTIVE, write=True)
@guarded
def start_reprocess(
    limit: int,
    country: str | None = None,
    platform: str | None = None,
    external_id: str | None = None,
    force: bool = True,
) -> str:
    """Startet Extraktion auf den LIVE-Daten (neue Live-Versionen!) mit der zugewiesenen LLM-Kette. limit 1-200. Laeuft im Hintergrund; Fortschritt ueber get_llm_jobs. Fuer reine Vergleiche run_trial nehmen."""
    if not 1 <= limit <= 200:
        return "FEHLER: limit muss zwischen 1 und 200 liegen."
    body: dict[str, Any] = {"limit": limit, "force": force}
    if country:
        body["country"] = country
    if platform:
        body["platform"] = platform
    if external_id:
        body["externalId"] = external_id
    return out(admin.request("POST", "/api/settings/reprocess", body=body))


if __name__ == "__main__":
    mcp.run()
