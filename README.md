
---

### 🗂 `/social-mapping-socket-server/README.md`
```md
# Social Mapping WebSocket Server (Production Only)

This folder contains the standalone WebSocket server used in production, hosted on Render.

## Deployment

- Deployed via Render (auto from GitHub)
- Connects to production MongoDB (`SMapApp-prod`)

## Key Environment Variables

- `MONGODB_URI` – points to production Atlas cluster
- `CLIENT_URL` – for CORS (usually Vercel frontend)
- `PORT` – (usually 3001)

## Local Development

⚠️ Not intended for local use — use the embedded server in `social-mapping-nextjs` for that.
