# Deploying Symphony

Three deployment paths: local Docker Compose (quickstart), Google Cloud Run, or
any container platform.

## Prerequisites

1. **Linear API key** — a personal API key (`lin_api_...`) for your workspace.
2. **Anthropic API key** — `sk-ant-...` for Claude.
3. **Postgres database** — any Postgres 14+ instance. Symphony creates its own
   schema (`symphony`).
4. **GitHub App** — optional but needed for the PR validation + Release
   specialists to call `gh`. See below.
5. **WORKFLOW.md** — your config file. Start from `WORKFLOW.example.md`.

## Docker Compose (quickstart)

The fastest path to a running Symphony instance with a local Postgres.

```bash
# 1. Clone and configure
git clone https://github.com/your-org/symphony.git
cd symphony
cp WORKFLOW.example.md WORKFLOW.md
# Edit WORKFLOW.md — fill in tracker.api_key, tracker.team_id,
# github.owner, github.repo, and agent_runtime.model

cp .env.example .env
# Edit .env — fill in LINEAR_API_KEY, ANTHROPIC_API_KEY
# Leave DATABASE_URL blank — docker-compose overrides it automatically

# 2. Start
docker compose up --build
```

The Postgres schema is applied automatically on first start via
`docker-entrypoint-initdb.d/schema.sql`.

To apply schema migrations manually (after an upgrade):

```bash
docker compose exec symphony node dist/main.js --migrate-only
# or with npm directly:
npm run migrate
```

## Running locally (no Docker)

```bash
npm install
cp .env.example .env       # fill required vars
npm run migrate            # apply src/audit/schema.sql to your Postgres
npm run dev                # tsx watch — hot-reloads on src changes
```

Edit `WORKFLOW.md` while the daemon runs — config reloads live.

## Google Cloud Run

Symphony is designed for Cloud Run's `max-instances=1` constraint (required for
the singleton advisory lock).

### First-time setup

1. **Create the Cloud Run service** (one time):

   ```bash
   gcloud run services create symphony-orchestrator \
     --region=us-central1 \
     --project=<your-gcp-project> \
     --image=gcr.io/cloudrun/placeholder \
     --max-instances=1 \
     --min-instances=1 \
     --set-env-vars="NODE_ENV=production,LOG_LEVEL=info" \
     --no-traffic
   ```

2. **Set secrets** — store sensitive values in Secret Manager and wire them as
   env vars on the service:

   ```bash
   echo "$LINEAR_API_KEY" | gcloud secrets create symphony-linear-api-key \
     --data-file=- --project=<your-gcp-project>
   # repeat for ANTHROPIC_API_KEY, DATABASE_URL, etc.

   gcloud run services update symphony-orchestrator \
     --set-secrets="LINEAR_API_KEY=symphony-linear-api-key:latest,..." \
     --project=<your-gcp-project> --region=us-central1
   ```

3. **Run the schema migration** (one time per environment):

   ```bash
   # Use Cloud SQL proxy or tunnel to reach your database
   DATABASE_URL="postgresql://..." npm run migrate
   ```

4. **Configure the Linear webhook** (see below).

### Routine deploys

Build and push the image, then roll the service:

```bash
GOOGLE_CLOUD_PROJECT=<your-gcp-project> ./scripts/deploy.sh
```

Or set up a CI workflow (GitHub Actions example):

```yaml
# .github/workflows/deploy.yml
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_CREDENTIALS }}
      - run: GOOGLE_CLOUD_PROJECT=${{ vars.GCP_PROJECT }} ./scripts/deploy.sh
```

### Important: max-instances=1

The `scripts/deploy.sh` always passes `--max-instances=1` to `gcloud run services
update`. Do not change this — the singleton advisory-lock design requires exactly
one instance at a time.

## Linear webhook setup

The webhook gives Symphony real-time state-change notifications (sub-30s
latency vs. the 30s poll interval).

```bash
# 1. Generate a secret
WEBHOOK_SECRET=$(openssl rand -hex 32)

# 2. Register the webhook with Linear
curl -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation { webhookCreate(input: { url: \"https://<your-service-url>/webhooks/linear\", teamId: \"<your-team-id>\", secret: \"'"$WEBHOOK_SECRET"'\", allPublicTeams: false }) { success } }"
  }'

# 3. Store the secret as SYMPHONY_WEBHOOK_SECRET
```

## GitHub App setup (optional but recommended)

The PR validation and Release specialists use the `gh` CLI to check CI status
and merge PRs. This requires a GitHub token injected as `GITHUB_TOKEN`.

**Option A — GitHub App** (recommended for production):

1. Create a GitHub App with permissions: `contents: read`, `pull_requests: write`,
   `checks: read`, `statuses: read`.
2. Install it on your target repository.
3. Set `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY`.
   Symphony mints short-lived installation tokens automatically.

**Option B — Personal access token** (simpler for testing):

```bash
GITHUB_TOKEN=ghp_...
```

Set it as the env var `GITHUB_TOKEN`; the `gh` CLI will pick it up automatically.

## Linear GitHub auto-state wiring

The 16-state pipeline relies on Linear's native GitHub integration to move
sub-issues from "Implementation (manual)" → "Pull request" on PR push, and
→ "Done" on PR merge.

This is per-team configuration. Run once per team:

```bash
# Use the Linear API explorer at https://studio.apollographql.com/sandbox
# or the raw GraphQL mutation below.

curl -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "mutation($teamId: String!, $stateId: String!, $event: String!) { gitAutomationStateCreate(input: { teamId: $teamId, targetableId: $stateId, event: $event }) { success } }",
    "variables": {
      "teamId": "<your-linear-team-id>",
      "stateId": "<pull-request-state-id>",
      "event": "pull_request"
    }
  }'
# Repeat with "merge" event → Done state ID
```

Get state IDs via the Linear GraphQL API: `query { team(id: "<id>") { states { nodes { id name } } } }`.
