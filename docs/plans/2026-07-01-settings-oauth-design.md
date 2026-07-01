# /settings page — Claude OAuth login flow

Date: 2026-07-01
Status: Implemented on `feat/settings-oauth`.

## Goal

Enable the LLM extractor on the deployed instance without SSH access. A user
authenticated with a shared password can open `https://zvg.haex.cloud/settings`,
click "Login starten", complete Anthropic's OAuth flow in the browser, paste
the code back, and have the enrich task use the resulting Claude subscription
credentials from that point on.

## Current state

- LLM is disabled by default (`runtimeConfig.extractLlm.baseUrl` is empty in
  `nuxt.config.ts`); enrich task falls back to rules-only.
- `haex-claude-proxy` already ships a browser-driven OAuth flow at
  `/setup/*` (states: `idle` → `awaiting-url` → `awaiting-code` → `finishing`
  → `done` / `error`; snapshot returns `{ state, oauthUrl, errorMessage,
  startedAt }`; all routes guarded by `Authorization: Bearer PROXY_SETUP_TOKEN`).
- zvg-immo's `docker-compose.yml` currently has only the `app` service.
- zvg-immo has no auth — the whole site is public.

## Design decisions

1. **Per-project proxy**: haex-claude-proxy runs in the same docker-compose
   file as zvg-immo. Every project deploys its own proxy so credentials stay
   scoped per project.
2. **Custom Nuxt /settings page** (not iframe / not reverse-proxy of the
   proxy's `/setup/` UI): consistent styling with the rest of the app; the
   `PROXY_SETUP_TOKEN` stays server-side only and never reaches the browser.
3. **Simple password auth** (single `SETTINGS_PASSWORD` env var + HMAC-signed
   session cookie): sufficient for a solo deployment; no user database.

## Architecture

```text
Browser                    zvg-immo (Nitro)              haex-claude-proxy
  /settings                  /api/settings/*                 /setup/*
    │                          │                                │
    │  password ─────────▶ /api/settings/login                  │
    │  ◀───── session cookie                                    │
    │                                                           │
    │  ─────▶ /api/settings/claude/login                        │
    │                          │ Bearer PROXY_SETUP_TOKEN ──▶  spawn `claude
    │                          │                               auth login`
    │                          │  ◀── { state, oauthUrl } ─────    (via pty)
    │  ◀───── { state, oauthUrl }                               │
    │                                                           │
    │  ─────▶ /api/settings/claude/code                         │
    │           { code }                                        │
    │                          │  ────▶  writes code to pty  ──▶ finishing → done
    │                          │                                │  → .credentials.json
    │                          │                                │    lands in volume
    │  ◀───── { ok: true }                                      │
```

## Docker Compose

```yaml
services:
  app:
    build: .
    image: zvg-immo:latest
    container_name: zvg-immo
    restart: unless-stopped
    ports: ["3000:3000"]
    volumes: [geocode-cache:/app/.cache_zvg]
    environment:
      NODE_ENV: production
      NUXT_EXTRACT_LLM_BASE_URL: http://haex-claude-proxy:8080
      NUXT_EXTRACT_LLM_MODEL: claude-haiku-4-5
      NUXT_PROXY_SETUP_TOKEN: ${PROXY_SETUP_TOKEN}
      NUXT_SETTINGS_PASSWORD: ${SETTINGS_PASSWORD}
      NUXT_SETTINGS_SESSION_SECRET: ${SETTINGS_SESSION_SECRET}
    depends_on: [haex-claude-proxy]

  haex-claude-proxy:
    image: ghcr.io/haexhub/haex-claude-proxy:latest
    container_name: zvg-immo-claude-proxy
    restart: unless-stopped
    volumes: [claude-creds:/data]
    environment:
      PROXY_RESOLVER: file
      PROXY_CREDENTIALS_HOME: /data
      PROXY_SETUP_TOKEN: ${PROXY_SETUP_TOKEN}

volumes:
  geocode-cache:
  claude-creds:
```

`.env` (not committed, dokumentiert in `.env.example`):

```env
PROXY_SETUP_TOKEN=<openssl rand -hex 32>
SETTINGS_PASSWORD=<user-chosen>
SETTINGS_SESSION_SECRET=<openssl rand -hex 32>
```

## Auth for /settings

**Cookie:** `settings_session=<expiry-unix-ms>.<hmac-sha256(secret, expiry)>`.
HTTP-Only, Secure, SameSite=Lax, 24h sliding window (renewed on every
successful `/api/settings/*` request).

**Files:**

- `server/utils/settings-auth.ts` — `signSession(secret, expiry)`,
  `verifySession(secret, cookie, now)`, hash-then-`timingSafeEqual` password
  compare (no length-based short-circuit that would leak the real password's
  length through timing).
- `server/middleware/settings-auth.ts` — guards `/api/settings/*` (whitelisted:
  `login`, `session`); 401 on failure. Refreshes the cookie on every
  authorized request.
- `server/api/settings/login.post.ts` — hash-based timing-safe compare against
  `SETTINGS_PASSWORD`; sets the cookie on match.
- `server/api/settings/logout.post.ts` — clears the cookie.
- `server/api/settings/session.get.ts` — public probe returning
  `{ authed: boolean }` so the page mount can pick the right initial view.

**Rate-limit:** in-memory counter keyed by socket peer IP by default. When the
app runs behind a trusted reverse proxy that overwrites `x-forwarded-for`
(e.g. Traefik in a compose network with port 3000 not publicly exposed), set
`NUXT_TRUST_FORWARDED_FOR=1` so the limit tracks real clients rather than the
proxy's IP. 5 failed attempts → 60 s lock. Map is capped at 10 000 keys with
sweep-on-check to prevent unbounded growth from a rotating-IP scanner.

**Explicitly out of scope:** password reset, recovery codes, 2FA, multi-user.

## Claude-OAuth API (thin passthrough)

All routes require a valid `settings_session` cookie; the middleware handles
that. Every wrapper is `$fetch` at `http://haex-claude-proxy:8080/setup/*` with
`Authorization: Bearer <PROXY_SETUP_TOKEN>` from `useRuntimeConfig().proxySetupToken`.
`AbortSignal.timeout(10_000)` on every call.

```text
GET  /api/settings/claude/status → { state, oauthUrl?, errorMessage?, hasCredentials }
POST /api/settings/claude/login  → { oauthUrl }         // proxies /setup/login
POST /api/settings/claude/code   → { ok: true }         // proxies /setup/code
POST /api/settings/claude/reset  → { ok: true }         // proxies /setup/reset
```

`hasCredentials` — read from a proxy endpoint if it exists; otherwise implement
a small `/setup/credentials-exists` upstream (small PR against
haex-claude-proxy) that checks whether `PROXY_CREDENTIALS_HOME/.claude/.credentials.json`
exists. Fallback: infer from a successful status snapshot in the `idle` state
by attempting a probe request against `/v1/models` — but that's flakier, so
prefer the upstream extension.

## `nuxt.config.ts` additions

```ts
runtimeConfig: {
  extractLlm: { baseUrl: '', model: 'claude-haiku-4-5' },
  proxySetupToken: '',           // NUXT_PROXY_SETUP_TOKEN — server only
  settingsPassword: '',          // NUXT_SETTINGS_PASSWORD
  settingsSessionSecret: '',     // NUXT_SETTINGS_SESSION_SECRET
}
```

None of these leak into `runtimeConfig.public` — they only reach the server
side.

## UI (`pages/settings.vue`)

Single file, ~250 LOC. Same `h-full overflow-y-auto` pattern as the detail
route so the global `body { overflow: hidden }` doesn't lock scrolling.

```text
<header> ← Zurück zur Übersicht · h1 "Einstellungen"

v-if="!authed":
  Password login form (single input + submit).

v-else:
  Claude section — sub-view depends on status.state:

    'idle' + !hasCredentials:
      "Nicht verbunden" + [Login starten]

    'idle' + hasCredentials:
      "✓ Bereits angemeldet" + [Neu verknüpfen] + [Abmelden]

    'awaiting-url':
      Spinner + "Öffne Anthropic-Login…"

    'awaiting-code':
      oauthUrl as target=_blank link, textarea for code,
      [Bestätigen] + [Abbrechen]

    'finishing':
      Spinner + "Prüfe Anmeldung…"

    'done':
      "✓ Erfolgreich verbunden" + [OK]  (=reset to idle)

    'error':
      errorMessage in red + [Erneut versuchen]
```

**Polling:** `setInterval(fetchStatus, 2000)` while state ∈
`{ awaiting-url, awaiting-code, finishing }`. Cleared in `onBeforeUnmount`.

**Style:** `bg-card border rounded-xl p-5 space-y-4`. Primary button
`bg-primary text-primary-foreground`, secondary `border`. Reuses existing
Tailwind tokens — no new shadcn components.

**Homepage:** add a Cog icon link → `/settings` in `pages/index.vue`'s header,
next to the filter button.

## Testing

**Unit (vitest):**

- `settings-auth.test.ts` — `signSession()` produces correct HMAC-Format;
  `verifySession()` accepts valid signatures and rejects wrong HMAC / expired
  timestamps / tampering; rate-limit counter counts, blocks at 5, expires
  after 60 s.

Pure logic, no I/O. ~15 tests.

**Live verification (after deploy):**

1. Fill `.env` with the three secrets, `docker compose up -d`.
2. Both containers running: `docker compose ps` — `app` healthy,
   `haex-claude-proxy` startup log shows `[boot] resolver=file`.
3. Proxy reachable from zvg-immo: `docker compose exec app wget -qO-
   http://haex-claude-proxy:8080/healthz` → JSON with `claude --version`.
4. Browser: `zvg.haex.cloud/settings` → password form. Wrong password →
   401 + rate-limit lock after 5 attempts (`curl -X POST` reproduces).
5. Right password → Claude section "Nicht verbunden". Click "Login starten"
   → state moves to `awaiting-code`, `oauthUrl` shown as link.
6. Open link (target=_blank), authorise at Anthropic, copy code, paste into
   textarea, "Bestätigen". State → `finishing` → `done`. `docker compose exec
   haex-claude-proxy ls /data/.claude/` shows `.credentials.json`.
7. Manually trigger enrich (`docker compose exec app node -e "runTask('enrich')"`
   or wait for cron). Logs: `[enrich] … llm=claude-haiku-4-5 … llmCalls=N`.
8. On `/`, check a previously unenriched listing — after the run, new sizes
   from Gutachten PDFs should appear.
9. Restart test: `docker compose restart`. `/settings` shows "✓ Bereits
   angemeldet", enrich keeps working — credentials survive in the volume.

**Not tested (deliberate):**

- Anthropic OAuth token expiry/refresh — handled inside the proxy, we don't
  see it. On expiry the user re-runs the /settings flow.

## Unknowns

- Whether `haex-claude-proxy` already exposes a way to detect existing
  credentials without side effects. If not, add a small `/setup/credentials-exists`
  endpoint upstream. Fallback: derive from a state snapshot, less reliable.

## Risks / notes

- The Bearer token is in the compose env of both services; anyone with shell
  access on the host can read it. Acceptable for a solo deployment; would
  need a secrets manager in a multi-user setting.
- The proxy spawns a `claude` subprocess per LLM request — bounded by
  `MAX_LLM_PER_RUN = 250` in the enrich task, plus the 60 s
  `AbortSignal.timeout` added in the code-review-fix commit. Should not fork-bomb.
- `/settings` is behind TLS via Traefik + Let's Encrypt (existing setup),
  so the password is never sent in cleartext.
