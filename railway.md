# Railway deployment (monorepo)

This repo is a monorepo. Deploy the `signaling/` service first.

## Signaling service (recommended: Nixpacks)

In Railway:

- **Source**: GitHub repo `vigneshbunny/open-radio`
- **Root directory**: `signaling`
- **Builder**: Nixpacks
- **Environment variables**:
  - `ALLOW_ORIGINS=*`
  - (Railway sets `PORT` automatically)

This service includes `signaling/nixpacks.toml` to force Node.js + npm in the build image.

If you still see `npm: not found`, ensure:
- the service root is set to `signaling`
- builder is Nixpacks (not Docker)
- and set `NIXPACKS_CONFIG_FILE=nixpacks.toml` in Railway service variables.

