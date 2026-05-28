# Symphony Slack observer — setup & rotation

Symphony posts a threaded card per Linear issue it works, with replies for
each lifecycle event (dispatch, outcome, reconciliation). When the bot
token is missing or invalid the observer silently no-ops — Symphony itself
keeps running.

The observer's auth-failure handling is deliberately quiet: on the **first**
`invalid_auth` (or `not_authed`, `token_revoked`, `token_expired`,
`account_inactive`, `missing_scope`) it logs **one** warning and disables
itself for the rest of the process lifetime. Restart the daemon after
rotating the token.

## Required Slack OAuth scopes

The bot needs these Bot Token Scopes (under "OAuth & Permissions" in the
Slack app dashboard):

| Scope               | Why                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `chat:write`        | Post messages as the bot. Required.                                                                      |
| `chat:write.public` | Post into public channels the bot has not been invited to. Drop this if you always invite the bot first. |
| `channels:read`     | Look up channel IDs by name when configuring. Optional but useful for debugging.                         |

If the token is installed without `chat:write`, every post fails with
`missing_scope` and the observer disables itself.

## Provisioning a fresh app (one-time)

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**.
2. Name it `Symphony` and pick your workspace.
3. Under **OAuth & Permissions** → **Bot Token Scopes**, add the scopes above.
4. Click **Install to Workspace**, approve, and copy the **Bot User OAuth Token**
   (starts with `xoxb-`).
5. Invite the bot to the target Slack channel:

   ```
   /invite @Symphony
   ```

   (skip if you have `chat:write.public` and the channel is public).

6. Note the channel ID — open the channel in Slack, click the channel name,
   scroll to the bottom of the popup. Format: `C0123456789`.

## Storing the token

Set `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` in your environment (`.env`,
Secret Manager, or equivalent):

```bash
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_CHANNEL_ID=C0123456789
```

If using Google Cloud Secret Manager:

```bash
echo "$BOT_TOKEN" | gcloud secrets versions add symphony-slack-bot-token \
  --data-file=- \
  --project=<your-gcp-project>
```

The next revision picks up `version: "latest"` automatically. Restart the
running daemon so the in-memory `slackHealthy` flag resets.

## Verifying the token

```bash
curl -s -H "Authorization: Bearer $BOT_TOKEN" https://slack.com/api/auth.test | jq
```

Expected: `"ok": true`. If `ok: false` and `error: "invalid_auth"`, the token
is wrong or has been revoked — go back to the Slack app dashboard and re-install.

To verify the bot can post into the configured channel:

```bash
curl -s -X POST https://slack.com/api/chat.postMessage \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d "{\"channel\":\"$CHANNEL_ID\",\"text\":\"symphony auth.test ping\"}" | jq
```

Common failure modes:

| `error`             | Fix                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------- |
| `invalid_auth`      | Token wrong or app uninstalled. Re-copy from the Slack app dashboard.               |
| `not_in_channel`    | Bot needs to be invited (`/invite @Symphony`) or the app needs `chat:write.public`. |
| `missing_scope`     | App was installed without `chat:write`. Re-install after adding the scope.          |
| `channel_not_found` | Bad channel ID. Re-copy from the Slack channel popup.                               |

## Why the observer goes quiet on the first error

Each Symphony dispatch calls `announceDispatch` and `announceOutcome`. With
a broken token, that's 2 failed Slack calls per issue, potentially dozens per
day — flooding the structured log with identical warnings. We collapse it to
one actionable line per process lifetime:

```
slack disabled — invalid_auth; configure SLACK_BOT_TOKEN with chat:write scope
```

After rotation, restart the daemon — the in-memory health flag resets on boot.

## Source

- Implementation: [`src/observability/slack.ts`](../src/observability/slack.ts)
- Tests: [`tests/unit/slack.test.ts`](../tests/unit/slack.test.ts)
