# ● DIS

[![DIS ci](https://github.com/fitzyracing1/DIS/actions/workflows/ci.yml/badge.svg)](https://github.com/fitzyracing1/DIS/actions/workflows/ci.yml)
[![DIS status](https://github.com/fitzyracing1/DIS/actions/workflows/status.yml/badge.svg)](https://github.com/fitzyracing1/DIS/actions/workflows/status.yml)

**A self-hostable status bot: it watches your sites and marks each one lit or dark.**
Point DIS at your sites and it checks them on a schedule. Each target is **lit** (up and healthy) or **dark**
(down, erroring, or too slow). DIS sends a webhook when a light changes, serves a small status page plus JSON,
and can also run as a GitHub Actions cron job, so you don't need a server.

Node 18+, **zero dependencies**, MIT. Part of the lit/dark family with
[light-report](https://github.com/fitzyracing1/light-report): DIS can mirror every target to a light-report server.

![DIS status page](docs/status-page.png)

## Quick start

```bash
git clone https://github.com/fitzyracing1/DIS.git && cd DIS
node bin/dis.mjs once      # check everything once: exit 0 = all lit, 1 = something dark
node bin/dis.mjs serve     # run forever; open http://localhost:8080
npm test                   # node:test, no install needed
```

Then edit `status.config.json` to watch your own sites. If you `npm link` it, the command is just `dis`.

## Config: `status.config.json`

```json
{
  "title": "My status",
  "defaults": { "intervalSeconds": 60, "timeoutMs": 10000, "maxLatencyMs": 5000, "failThreshold": 2, "recoverThreshold": 1 },
  "targets": [
    { "name": "site",     "type": "http", "url": "https://example.com", "expectStatus": 200, "keyword": "Example Domain", "maxLatencyMs": 3000 },
    { "name": "postgres", "type": "tcp",  "host": "db.example.com", "port": 5432, "intervalSeconds": 120 },
    { "name": "dns",      "type": "dns",  "host": "example.com", "recordType": "A" }
  ],
  "alerts": [
    { "type": "discord", "url": "${DISCORD_WEBHOOK_URL}" },
    { "type": "slack",   "url": "${SLACK_WEBHOOK_URL}", "on": ["dark"] },
    { "type": "json",    "url": "${ALERT_WEBHOOK_URL}" }
  ],
  "lightReport": { "url": "${LIGHT_REPORT_URL}", "prefix": "net-", "heartbeatMinutes": 15 }
}
```

- `${VAR}` in any string is filled in from the environment, so secrets stay in env vars. If an alert or
  `lightReport` URL comes out empty, that adapter is just switched off. The shipped config works with no env set.
- Each target can override any value in `defaults`.
- To set the whole config from one env var, put the JSON in `DIS_CONFIG_JSON`. Handy on Railway.
  Use `DIS_CONFIG` to point at a different file.
- See [`examples/all-check-types.config.json`](examples/all-check-types.config.json) for an example of every option.

### Check types

| type | fields | lit when |
|---|---|---|
| `http` | `url`, `method` (GET), `expectStatus` (default `"200-399"`; also `200`, `"2xx"`, `[200, 204]`), `keyword`, `headers`, `followRedirects` (true) | status matches, the body contains `keyword` if one is set, and the full response arrives within `maxLatencyMs` |
| `tcp` | `host`, `port` | the port accepts a connection within `maxLatencyMs` |
| `dns` | `host`, `recordType` (`A` AAAA CNAME MX TXT NS), `expect` (substring), `server` (e.g. `1.1.1.1`) | it resolves to at least one record, matching `expect` if one is set |

Common fields: `name` (letters, digits, `. _ -`), `intervalSeconds` (60), `timeoutMs` (10000), `maxLatencyMs` (5000).

### Lit, dark and debounce

- **lit → dark** only after `failThreshold` failures in a row (default **2**), so one blip doesn't page you.
- **dark → lit** after `recoverThreshold` successes in a row (default 1).
- Alerts fire **only on a change**. The first lit after startup is silent; a first dark is not.
- Uptime is shown for all time and for the last 24 h (the last 1440 checks per target are kept).

## Alerts (webhooks)

| type | body |
|---|---|
| `discord` | `{username, content, embeds:[…]}`: paste a Discord channel webhook URL |
| `slack` | `{text}`: a Slack incoming webhook URL |
| `json` | `{event:"state_change", name, type, target, from, to, light, bit, detail, at, text}`: anything else |

Optional per-alert fields: `"on": ["dark"]` to hear only about outages, and `"headers": {…}` (e.g. an auth header for `json`).
A failing webhook is logged and never stops the checks.

## Optional: report to light-report

If `lightReport.url` is set, each target is also posted as a light `<prefix><name>` (e.g. `net-patch-cloud`)
using light-report's API: `POST /lights/:name` with `{"state":"lit"|"dark","source":"dis","detail":…}`.
It posts when a light changes, plus a heartbeat every `heartbeatMinutes` so the light doesn't go stale
(light-report marks lights dark after its TTL, 24 h by default). Cron mode posts on every run.

Tokens: the first report of a new name gets back a write token, and DIS saves it in the state file.
Token lookup order: `lightReport.tokens["<target>"]` → env `LIGHT_TOKEN_<LIGHT_NAME>` (same convention as `light-run`,
e.g. `LIGHT_TOKEN_NET_PATCH_CLOUD`) → env `LIGHT_TOKEN` → `lightReport.token` → the saved token.
On an ephemeral host (no volume, or GitHub Actions without the cache), pin the tokens as env vars or secrets.
Tokens are never printed when `CI` / `GITHUB_ACTIONS` is set.
Then read the lights back with `curl $LIGHT_REPORT_URL/lights/net-patch-cloud/LIGHT` or use a badge.

## Web page and JSON

| | |
|---|---|
| `GET /` | status page (refreshes every 30 s) |
| `GET /status.json` (alias `/api/status`) | `{title, light, counts, generatedAt, targets:[{name, type, target, light, bit, since, lastCheck, uptime:{all,"24h"}, checks, lastChange}]}` |
| `GET /lights/:name` · `/lights/:name/LIGHT` | one target as JSON · `lit` / `dark` / `pending` |
| `GET /LIGHT` | `lit` only when every target is lit |
| `GET /healthz` | `ok`: DIS itself is up (use this for platform health checks) |

## State

State lives in one JSON file, written atomically: `$DIS_STATE`, else `$DATA_DIR/state.json`, else `./data/state.json`.
Use `--no-state` to keep it in memory only. Restarting keeps the lights, the failure counts and the uptime.
The state file can hold light-report write tokens, so keep it out of git (`.gitignore` already does this).

## Deploy

### Docker

```bash
docker build -t dis .
docker run -d -p 8080:8080 -v dis-data:/data \
  -e DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/… dis
# your own config:  -v $PWD/status.config.json:/app/status.config.json:ro
```

### Railway

1. Create a new project from this repo. Railway uses the `Dockerfile` and `railway.json` (health check `/healthz`).
2. Railway sets `PORT`; DIS reads it.
3. Add a volume mounted at `/data` so state and uptime survive redeploys.
4. Set `DISCORD_WEBHOOK_URL` / `SLACK_WEBHOOK_URL` / `ALERT_WEBHOOK_URL` / `LIGHT_REPORT_URL` as needed.
   To change targets without a commit, set `DIS_CONFIG_JSON`.
5. Generate a domain to get a public status page.

### GitHub Actions (no server)

[`.github/workflows/status.yml`](.github/workflows/status.yml) runs `dis once` every 10 minutes.
The job **fails (exit 1) when anything is dark**, so GitHub notifies you. The state file is carried between runs with
`actions/cache`, so webhooks fire only on changes. Nothing is posted anywhere until you opt in: add
`DISCORD_WEBHOOK_URL` / `SLACK_WEBHOOK_URL` / `ALERT_WEBHOOK_URL` as repo **secrets**, or `LIGHT_REPORT_URL` as a repo
**variable**. The first step prints what is enabled, and every run writes a step summary table.
GitHub may delay scheduled runs and disables them after 60 days without repo activity.

## CLI

```
dis serve      run forever; web page + JSON on $PORT (default 8080)
dis once       check everything once; exit 0 = all lit, 1 = something dark, 2 = config error
dis validate   check the config and list what is enabled
  --config <file>  --state <file>  --no-state  --port <n>  --json (once)  --retry-delay <ms> (once, default 5000)
```

In `once` mode, a failing target is retried until it reaches `failThreshold` failures (the same debounce as the server).
`--json` prints the snapshot to stdout; progress logs go to stderr.

The npm package name is `dis-status` (not published; `"private": true` guards against an accidental publish).

## License

MIT © 2026 Joshua Almeida
