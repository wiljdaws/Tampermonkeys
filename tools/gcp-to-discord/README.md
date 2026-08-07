# gcp-to-discord

Tiny Cloud Run service that receives Google Cloud Monitoring alert webhooks
and posts them as formatted embeds to a Discord channel.

## One-time setup

### 1. Create a Discord webhook

- Right-click the channel you want alerts in → **Edit Channel**
- **Integrations** → **Webhooks** → **New Webhook**
- Name it "GCP Monitoring", copy the webhook URL.

### 2. Deploy this service to Cloud Run

Pick any long random string as `SHARED_SECRET` so random internet POSTs
can't spam your Discord.

```bash
cd tools/gcp-to-discord

SECRET="$(openssl rand -hex 32)"
DISCORD_URL="https://discord.com/api/webhooks/..."  # from step 1

gcloud run deploy gcp-to-discord \
  --source . \
  --project rgleaderboard \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "DISCORD_WEBHOOK_URL=${DISCORD_URL},SHARED_SECRET=${SECRET}"
```

Cloud Run prints the service URL. Save `${SECRET}` and the URL — you'll use
them in the next step.

### 3. Wire GCP Monitoring to it

- Open **Monitoring → Alerting → Notification channels** in the GCP console
- **Add new** → **Webhook**
- Endpoint URL: `https://<service-url>/?token=<SHARED_SECRET>`
- Display name: `Discord (via gcp-to-discord)`
- Save

Now any alerting policy that adds this channel will push a Discord embed
whenever it fires or resolves.

## Local test

```bash
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." node index.mjs
# in another terminal:
curl -sS -X POST http://localhost:8080/ \
  -H "Content-Type: application/json" \
  --data '{"incident":{"state":"OPEN","summary":"test alert","policy_name":"Firestore reads spike"}}'
```

You should see a red "🚨 GCP alert firing" embed appear in Discord.

## Cost

Cloud Run has a generous free tier (2M requests/mo, ~360k CPU-seconds).
Realistic alert volume of tens of events per day is well inside free tier.
