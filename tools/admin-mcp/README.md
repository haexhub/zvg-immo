# zvg-admin MCP-Server

Lokaler MCP-Server (stdio), mit dem Claude Code die Admin-API (`/api/settings/*`)
nutzen kann, ohne dass das Passwort im Modell-Kontext landet. Er meldet sich wie
die `/settings`-Seite über `POST /api/settings/login` an und hält das
Session-Cookie nur im eigenen Prozess. Es gibt bewusst kein generisches
„beliebigen Endpunkt aufrufen“-Tool.

## Einrichten

1. Passwort in eine Datei legen, nur für dich lesbar:
   ```sh
   mkdir -p ~/.config/zvg-admin && install -m 600 /dev/null ~/.config/zvg-admin/password
   # Passwort hineinschreiben (z. B. mit deinem Editor) – ohne Zeilenumbruch-Pflicht
   ```
2. Server registrieren (benötigt [`uv`](https://docs.astral.sh/uv/); es installiert die Abhängigkeiten selbst):
   ```sh
   claude mcp add zvg-admin --scope user \
     -e ZVG_ADMIN_PASSWORD_FILE=~/.config/zvg-admin/password \
     -- uv run --script /pfad/zu/zvg-immo/tools/admin-mcp/zvg_admin_mcp.py
   ```

Umgebungsvariablen: `ZVG_BASE_URL` (Default `https://zvg.haex.cloud`),
`ZVG_ADMIN_PASSWORD_FILE` bzw. `ZVG_ADMIN_PASSWORD`, `ZVG_MCP_READONLY=1`
(registriert nur die Lese-Tools).

## Tools

| Art | Tool |
|---|---|
| Lesen | `get_operations`, `get_llm_overview`, `list_llm_profiles`, `get_llm_kill_switch`, `get_llm_costs`, `get_llm_jobs`, `get_auction_technical`, `get_auction_version`, `compare_auction_versions`, `compare_trial_to_live` |
| Probelauf | `run_trial` – schreibt nur eine Trial-Version, die Live-Version bleibt unverändert; wartet bis zu `wait_seconds` (Default 240) |
| Schreiben (Live-Wirkung) | `set_llm_kill_switch`, `set_llm_assignments`, `start_reprocess`, `delete_trial_version` (lehnt Nicht-Trials ab) |

Schreib-Tools sind als nicht-readonly markiert, Claude Code fragt vor jedem
Aufruf nach. Die Live-wirksamen (`set_*`, `start_reprocess`, `delete_*`) sollten
nicht dauerhaft freigegeben werden. LLM-Profile (mit API-Keys) lassen sich hier
bewusst nicht anlegen oder ändern – das bleibt in den Settings.

Läuft `run_trial` länger als das Tool-Timeout des Clients, kann das Timeout über
die Umgebungsvariable `MCP_TOOL_TIMEOUT` (ms) angehoben werden.

## Tests

Starten den Server gegen eine lokale Fake-API (kein Netzwerk, keine Produktion):

```sh
uv run --with "mcp>=1.2,<2" --with httpx --with pytest --with anyio pytest tools/admin-mcp
```
