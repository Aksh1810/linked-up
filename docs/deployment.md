# Vercel deployment runbook

Linked-Up deploys as one Vercel project. Vercel serves the static game and two short-lived Functions; a free Upstash Redis database stores rooms and WebRTC signaling messages. The host player's browser runs the authoritative Wasm simulation, so no permanent game server is required.

Current public alpha: [vercel-public-alpha-three.vercel.app](https://vercel-public-alpha-three.vercel.app)

## One-time setup

1. Create or use a Vercel Hobby project and install the Vercel CLI.
2. From the repository root, run `vercel login` and `vercel link`.
3. In the Vercel Marketplace, add **Upstash Redis** to the project. Choose the free plan, turn eviction on, and keep automatic paid upgrades off. The app requires the TLS `rediss://` connection exposed as `REDIS_URL`.
4. Connect the integration to Development, Preview, and Production. Confirm the variable without printing its credential:

   ```sh
   vercel env ls
   vercel env pull .env.local --environment=development
   node --env-file=.env.local -e 'console.log(new URL(process.env.REDIS_URL ?? "redis:").protocol)'
   ```

   The last command must print `rediss:`. Never commit `.env.local` or paste `REDIS_URL` into logs. The official Redis free Marketplace plan currently lacks TLS and is intentionally rejected by the application.

Useful references: [Vercel Marketplace storage](https://vercel.com/docs/marketplace-storage), [Upstash's Vercel integration guide](https://upstash.com/docs/redis/howto/vercelintegration), and [Redis Cloud TLS availability](https://redis.io/docs/latest/operate/rc/security/database-security/tls-ssl/).

## Verify and deploy

Install and run the repository checks:

```sh
npm ci
npm --prefix client ci
npm test
npm --prefix client run typecheck
node simulation/wasm/wasm_bridge_test.mjs
node --test scripts/deployed-smoke.test.mjs scripts/verify-vercel-build.test.mjs
```

Build the exact production artifact, validate it, and deploy it:

```sh
vercel pull --yes --environment=production
vercel build --prod --yes
node scripts/verify-vercel-build.mjs .vercel/output
vercel deploy --prebuilt --prod
```

Run the live release check against the stable production alias:

```sh
node scripts/deployed-smoke.mjs https://vercel-public-alpha-three.vercel.app
```

It validates the landing page and security headers, SPA room deep links, room creation and reading, host map selection, joining, authenticated signaling, guest start rejection, and host start. It creates only an expiring test room and never prints player tokens.

Finally, open two separate browser profiles, create a two-player room, join through its invite link, select each map as host, and start a match. Both players should reach **CLIMB TOGETHER**. Test once with players on different networks before announcing a wider release.

## Operations and limits

- Keep the host tab open and visible during a match. Closing it ends the peer-hosted simulation.
- There is no TURN relay in this free alpha. Strict VPN, school, workplace, carrier, or symmetric-NAT combinations can prevent direct WebRTC connectivity.
- Rooms and signaling messages expire automatically. Redis stores credential digests; raw player tokens remain only in each player's browser.
- Keep Upstash automatic upgrades disabled and monitor its Vercel Marketplace usage page. When a free limit is exhausted, new rooms should fail rather than create a bill.
- Check recent production errors with `vercel logs https://vercel-public-alpha-three.vercel.app --no-follow --since 1h --expand`.
- Inspect a release with `vercel inspect <deployment-url>`. If a deployment is bad, use the Vercel dashboard to promote the last known-good deployment, or run `vercel rollback <known-good-deployment-url>` after confirming the target.

## Release checklist

- All repository, native simulation, Wasm parity, and Vercel artifact checks pass.
- The live deployment smoke reports 12 passing checks.
- Two isolated browser profiles join and start a match without console errors.
- Classic Ascent, Relay Ridge, Crane Shift, and Windworks are selectable only by the lobby host.
- A two-player match has been tested across two genuinely different internet connections.
- Vercel and Upstash usage remain within their free allowances, with paid auto-upgrade disabled.
