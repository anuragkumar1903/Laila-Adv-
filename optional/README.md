# optional/

This folder contains **optional services** that Laila can integrate with, but does not require to function.

## Contents

### `docker-compose.yml`

Runs two optional services via Docker:

| Service | Port | Purpose |
|---------|------|---------|
| Redis   | 6379 | Reserved for future caching / pub-sub (not used by core Laila yet) |
| n8n     | 5678 | Local workflow automation for task notifications (fire-and-forget) |

## When do you need this?

**You don't** — unless you want n8n workflow notifications.

Laila's core features (scanning, agents, LLM, file editing, shell tool, history) all work without Docker, Redis, or n8n.

## Enabling n8n notifications

1. Install Docker Desktop
2. Run `docker compose up -d` from this folder
3. Set `N8N_ENABLED=true` in your environment
4. Set `N8N_WEBHOOK_URL=http://localhost:5678/webhook/laila` (default)

Laila will then send fire-and-forget events to n8n on task completion and validation failures. If n8n is down, nothing breaks.

## Enabling without Docker

You can also run n8n directly without Docker:

```bash
npm install -g n8n
n8n start
```

Then set `N8N_ENABLED=true` as above.
