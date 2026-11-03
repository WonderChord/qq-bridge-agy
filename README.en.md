# QQ ↔ Antigravity / DeepSeek Harness Bridge

Bridge QQ chats to Antigravity or DeepSeek Harness through a local OneBot v11 gateway. Configure an allowlist for the groups and friends that should receive replies.

Use Node.js 22.13 or newer. Run `npm ci` and `npm test`, then copy `config.example.json` to `config.json`. For Antigravity, set `dsh.baseUrl` to `agy://local`, install the bundled plugin and start its workers. For DSH, keep the local HTTP address and install the QQ presets. Start the bridge with `npm start`. The local console shows the selected backend and, for Antigravity, waiting workers, busy workers and queued wakes.

[中文](README.md) · [Antigravity setup](docs/guides/ANTIGRAVITY.md) · [DSH setup](docs/guides/DSH_SETUP.md) · [Documentation index](docs/README.md)

Based on Derpyu520/qq-bridge v0.2.1-r1. The Antigravity extensions were developed with AI assistance and are distributed under the [MIT license](LICENSE).

## Architecture

```
QQ messages ──► SnowLuma / NapCat (OneBot v11 WS) ──► qq-bridge ──► DSH Web API (127.0.0.1:3080/api)
                                                          │     └──► or Antigravity (dsh.baseUrl = "agy://local")
                                                          ▲                      │
                                                          └── replies / stickers / TTS / images ┘
```

## Antigravity (AGY) + Headless NapCat Mode

In addition to DeepSeek Harness (DSH), `qq-bridge` now natively supports **Google Antigravity (AGY)** via zero-polling long-poll wakeups (`dsh.baseUrl = "agy://local"`) and **Headless NapCat** daemon management under the same MIT license:

- **Ultra-Low-Token 3-Subagent Architecture (`agy-plugin/`)**:
  1. **`qq-chat-worker` (`w1`)**: Single-worker KV-cache-warmed chat loop with compact wake headers and batched messages. Uses `scripts/agy-reply-and-wait.mjs` to send text/batch replies, stickers (`--sticker`), native QQ voice bubbles (`--tts`), or Codex drawings (`--codex-draw`) and mark messages read in **one command**, rotating cleanly every **25 turns**.
  2. **`qq-flash-judge` (`flash`)**: Zero-token pre-filter strips single-char/image-only noise before passing ambiguous nickname hits (`persona.ambiguousKeywords`) and `0.12` diving samples (with 14-message context) to Flash for instant `yes/no` gating; rotates every **30 turns**.
  3. **`qq-memory-archivist` (`flash`)**: Asynchronous compartmented long-term memory archiver configured via `persona.memoryCompartments` (e.g. every 150 group messages / 40 private messages), stored in the configured directories.
- **Zero-Deployment Dual-Provider TTS (`/api/socialV2/send-tts` & `--tts`)**:
  - Supports **ElevenLabs** (`ELEVENLABS_API_KEY` env var, `eleven_v3`) as primary and **Google TTS** (keyless GTX endpoint) as automatic fallback, encoding native QQ SILK voice bubbles via `ffmpeg` + OneBot `record`.
- **Headless NapCat Kernel Probe & Self-Healing (`scripts/ensure-daemons.ps1`)**:
  - Detects silent NTQQ MSF kernel hangs via `get_stranger_info(no_cache: true)` and restarts headless NapCat hidden (`ShowWindow=0`) with ticket-only `SetQuickLogin` (`scripts/napcat-auto-relogin.mjs`).

See **[docs/guides/ANTIGRAVITY.md](docs/guides/ANTIGRAVITY.md)** for full setup instructions.

- **QQ side**: `@snowluma/sdk` provides the OneBot v11 WebSocket client.
- **DSH side**: adapted for DSH 0.1.2+ and **re-verified on 0.2.1-rc.2** — session Cookie minted from the persistent local signing key, `/api/<namespace>/<method>` slash RPC, and `/api/remote.mux` + `session/follow` event stream (the pending queue is read from `value.projections[<id>].values.inbox`, with the unary `session/projections` RPC as the primary path). The per-session model is pinned by the bridge via `session.selectModel` from `config.json`'s `dsh.model` (default `deepseek-flash` = DeepSeek-V41-Flash, multimodal).
- **Agent tools**: three bundled MCP servers expose a restricted QQ toolset (`qq_status`, `qq_list_groups`, `qq_get_group_history`, `qq_send_group_message`, `qq_reply`, etc.), a read-only host probe (`snowluma_status` only), and a read-only `web_search` / `web_fetch` pair with SSRF protection.
  ⚠️ **`start_snowluma` / `stop_snowluma` (and `snowluma.allowProcessControl`) were removed in v0.1.5**: SnowLuma EULA §5.4 requires prior written permission to deploy its proprietary native components through automated scripts. This program only probes, never deploys — installing, starting and scanning SnowLuma is always up to you. See [LICENSE](LICENSE) and [RULES.md](RULES.md).
- **Console**: a local web console at `http://127.0.0.1:3100`, organised into ten task-based pages (Overview, Sessions & Approvals, Persona, Social v2, Social v1, Slang, Usage & Cost, Access & Security, Operations, Tool Reference) with cross-page feature search and a **light / dark theme** (one-click toggle in the header; follows the OS preference until you choose), for mode switching, role management, whitelist/admin settings, slang management, memory, stickers and more. The Persona page manages roles (view/edit/rename/duplicate/delete the prompt of each persona), shows and edits both prompt layers separately — the **simulation prompt** built into the preset (tool/behaviour protocol; synced to DSH, restart required) and the **persona prompt** (`roles/*.md`; applied immediately) — and sets the **DSH reasoning effort** (`max` by default, `high`/`low` selectable). The **Usage & Cost** page shows real-time token consumption and its price in CNY, broken down per group/friend and per conversation turn (see [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md)).

## Features

- Bridges QQ group/private messages to DSH agent sessions.
- Social simulation mode ("simulated group friend") with idle/active/probing/exiting states.
- Space-based message splitting for more natural multi-message replies.
- Whitelist/blacklist access control, fail-closed by default.
- Sensitive text audit prevents paths/credentials from being sent to QQ.
- MCP tools for reading group history/members, sending messages, replying with quotes, and (in `reserved2`) full simulated-group-friend tooling.
- Slang/network-expression learning with human confirmation.
- Lightweight memory system for active topics, pending thoughts and member impressions.
- Sticker library integration with AI-friendly sticker usage.

## Requirements

- Node.js >= 22.13
- Running DeepSeek Harness Web (default `http://127.0.0.1:3080`)
- Running SnowLuma with OneBot v11 WebSocket and HTTP API enabled

## Quick Start

```bash
npm ci             # postinstall automatically patches the @snowluma/sdk ESM packaging bug
```

Copy `config.example.json` to `config.json`, then edit:

```bash
cp config.example.json config.json
```

Key settings:

| Field | Description |
| --- | --- |
| `dsh.baseUrl` | DSH Web API URL, default `http://127.0.0.1:3080` |
| `dsh.authToken` | DSH launch token (a process-launch credential). **Normally leave this empty**: with no token the bridge mints the session cookie offline from the persistent signing key in `~/.dsh/.credentials.yaml`, which depends on no per-process state (since DSH 0.1.7 the launch token lives only in memory — the one in the old logs belongs to a previous process and only yields a 401). A value here is honoured first if you set one |
| `dsh.authHeader` / `dsh.authPrefix` | Legacy fields kept for compatibility; the current path uses Cookie auth and does not send this header |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** URL (e.g. `ws://127.0.0.1:3001`) |
| `snowluma.accessToken` | OneBot access token, leave empty if not configured |
| `snowluma.httpUrl` | OneBot **HTTP API** URL (e.g. `http://127.0.0.1:3000`); do not point this at the WebSocket port or you will get HTTP 426 |
| `ownerQQ` | Administrator QQ (highest privilege) |
| `allow.private` / `allow.groups` | Whitelist of QQ/group IDs |
| `consolePort` | Local console port, default `3100` |

Start:

```bash
npm start
```

Or double-click `start.bat` on Windows (guard mode with auto-restart).

## DSH Setup on Another Device

The bridge and console can run without extra DSH setup, but the two DSH chat presets (`qq-chat` and `qq-chat-v2`) and the MCP servers must be installed into DSH once per machine:

```bash
node scripts/setup-dsh.mjs
```

This installs:

- the `qq-agent-presets` bundle, which generates the two `@deepseek-ai/dsh-agent-preset` rows (`qq-chat`, `qq-chat-v2`) plus the shared `qq-tool-restrict` safety guard
- MCP entries in `~/.dsh/profiles/web/cordis.patch.yml`
- `qq-mode-console` and `qq-agent-presets` in the profile `package.json` (`bundles` + `link:` dependencies)
- Default DSH mode set to `reserved2` (second-generation simulation), with a local `state/mode.json` fallback

Then restart DSH. See [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md) for details.

## Security Notes

- `config.json` and `state/` are **never committed**; the repository only ships `config.example.json`. Both are ACL-hardened to the owner / SYSTEM / Administrators (`npm run harden-acl`).
- MCP send tools enforce whitelist checks and reject CQ-code injection.
- Local paths, credentials, tokens and other sensitive patterns are filtered by the audit layer.
- Simulation sessions get **no local execution tools at all**: the preset's `qq-tool-restrict` row hides them from the tool schema at registration time and a runtime allowlist rejects anything outside the QQ MCP namespaces (`npm run scan:tool-names` re-checks that list against the installed DSH).
- The console uses a generated token when none is configured.

## Repository Layout

```
qq-bridge/
  config.example.json   # sanitized config template (real config.json is not in repo)
  docs/
    README.md           # documentation index (one line per doc + "still current?" notes)
    FOLDER_MAP.md       # folder layout and scripts/ naming conventions
    guides/             # user/operator facing: PROJECT_GUIDE, DSH_SETUP, VOICE, TOKEN_USAGE_CONSOLE, CONSOLE-UI-TESTING
    design/             # design & planning docs
    research/           # investigation notes
    audits/             # review / optimisation reports
    legacy/             # archived docs that were superseded
  dsh/agent-presets/    # qq-chat / qq-chat-v2 DSH agent preset templates
  plugins/qq-agent-presets  # DSH bundle: generates the qq-chat / qq-chat-v2 preset patch rows + the shared tool guard
  plugins/qq-mode-console  # DSH plugin: exposes the qq-mode settings namespace (host half only; no UI card yet)
  src/                  # bridge core and MCP servers
  public/
    console.html        # local web console
  roles/                # persona cards
  assets/               # images (the intro video ships as a release asset, not in the repo)
  scripts/              # tests and helper scripts
  state/                # runtime data (not in repo)
```

The standalone **voice sender tool** (`voice-cli.mjs`, `voice-gui.mjs`, `public/voice.html`, `发语音.cmd`)
lives in the sibling folder **`../voice-tool/`** — it only needs SnowLuma, and reuses this repo's
`src/voice-core.js` / `src/snowluma-conn.js` as the single shared implementation.

## Testing

Run `npm test` for the isolated bridge regression suite. Real QQ delivery and live DSH adaptation checks are separate.

After upgrading, legacy QQ session mappings without permission metadata are recreated once. Mode or preset changes also retire the old mapping and recreate the session on the next message; DSH history is retained.

```bash
npm run self-test       # DSH-side link test, no QQ/SnowLuma required
npm run test-md
npm run test-wait
npm run test-vision
npm run test-forward
npm run test-slang
npm run test-stickers
```

## Compliance

SnowLuma is an independent third-party project and is not affiliated with Tencent/QQ. This project is for learning and technical research only; please follow the relevant terms and the QQ User Agreement.
