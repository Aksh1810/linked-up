# .NET deployment runbook

The application is a static Blazor WebAssembly site on Vercel and an authoritative ASP.NET Core/BepuPhysics service on Render.

## Backend

1. Create the Render Blueprint from `render.yaml`.
2. Supply `REDIS_URL` and `LinkedUp__ClientOrigin` (the final Vercel origin).
3. Confirm `GET /health/ready` is healthy and copy the public HTTPS origin.

Render starts the service from `infrastructure/Dockerfile`. `RENDER_EXTERNAL_HOSTNAME` derives the secure gameplay WebSocket URL. The free service is intentionally single-instance; Redis-backed rooms survive a restart, while live matches end and can be recreated.

## Vercel client

Set `LINKEDUP_API_URL` to the Render HTTPS origin in the Vercel project, then build and deploy:

```sh
npm ci
env LINKEDUP_API_URL=https://linked-up-dotnet.onrender.com npm run build
node scripts/verify-vercel-build.mjs .vercel/output
vercel deploy --prebuilt --prod
```

The build script publishes the Blazor client in Release mode, writes the backend origin into `appsettings.json`, copies the static output into `.vercel/output/static`, and generates the CSP with the matching HTTPS/WSS origins.

## Verification

Run `npm test` before deployment. Then open two genuinely fresh browser tabs on the production alias, create a two-player room, join with its code, and start. Both tabs must show `Climb together`, a route/checkpoint, and `Linked tether` or a current authoritative tether state. Test all four host-selectable maps.

Set `LinkedUp__ClientOrigin` to restrict allowed browser origins for CORS and WebSockets. The Render endpoint remains public; player tokens and gameplay tickets authenticate access. Do not expose Redis credentials in logs or client responses.
