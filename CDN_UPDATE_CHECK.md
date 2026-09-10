# Serving `update_check` from the Cloudflare edge

## Why

`update_check` is answered directly by the App Service origin. Every device opens a TLS
connection to one of the Node processes, so a broadcast push notification turns into a
burst of simultaneous connections rather than a request rate the origin can absorb.

Measured on 2026-09-10, the origin sustains roughly **500 requests/sec per instance** and
starts returning 5xx above ~600. Because `server.setTimeout(0)` is set and the request
timeout was 120s, requests that clients had already abandoned kept occupying sockets, so
once the accept queue built up throughput collapsed rather than levelling off.

The responses are highly repetitive. Over the peak hour the number of distinct answers was:

| Dimension | Distinct values |
| --- | --- |
| `label` | 148 |
| `package_hash` | 174 |
| `deployment_key` + `app_version` + `label` + `package_hash` | **287** |

287 distinct answers. At a 30 second edge TTL the origin sees a few hundred requests per
30 seconds instead of thousands per second.

## The correctness constraint

The cached object in Redis is the *release list*, not the HTTP response. The response is
computed per request by `buildUpdateCheckBody`, and it genuinely varies by client:

- `label` / `package_hash` — a device already on the newest release is told
  `isAvailable: false`, and `applyDiffPayload` returns a **diff bundle keyed to that
  device's current hash**. Sharing an answer across different hashes serves the wrong diff.
- `client_unique_id` — `isClientSelectedForRollout` buckets by device, but **only while a
  rollout is still ramping**.
- `app_version`, `beta`, `is_companion` — all affect which releases are eligible.

So the edge cache key must be exactly:

```
deployment_key, app_version, label, package_hash, beta, is_companion
```

`client_unique_id` must be **excluded** from the key, or cardinality explodes to one entry
per device and caching does nothing.

Correctness for the rollout case is enforced at the origin, not in Cloudflare config. The
server now emits:

- `Cache-Control: public, max-age=30` when the answer is determined entirely by the
  parameters above.
- `Cache-Control: no-store` when a ramping rollout made the answer device-specific, and for
  degraded (storage-timeout) answers that don't reflect real deployment state.

Cloudflare only has to respect origin TTLs. A rollout automatically falls back to today's
behaviour instead of being silently wrong.

The TTL is controlled by `UPDATECHECK_EDGE_TTL_SECONDS` (default 30, `0` disables edge
caching entirely — a single app-setting change is enough to take the edge out of the path).

## Prerequisites (both done)

- **`Cache-Control: no-cache` on every response.** `routes/headers.ts` set this globally;
  `sendUpdateCheckResponse` now overrides it per response.
- **`ARRAffinity` cookie.** App Service session affinity attached a `Set-Cookie` to every
  response, and Cloudflare will not cache a response carrying `Set-Cookie`. Affinity is
  disabled (`clientAffinityEnabled: false`) — it was useless for a stateless API and was
  also skewing load distribution.

## Choosing an implementation

Cloudflare's default cache key includes the **full query string**, and `client_unique_id` is
in it. That has to be dealt with, and how depends on your plan.

### Option A — Enterprise custom cache key (simplest, no code)

Cache Rules let Enterprise zones set a custom cache key. Create a rule matching the
update-check path with:

- **Cache eligibility:** Eligible for cache
- **Edge TTL:** Respect origin (so `max-age`/`no-store` drive behaviour)
- **Cache key → Query string:** *Include only* `deployment_key`, `app_version`, `label`,
  `package_hash`, `beta`, `is_companion`

No Worker, no per-request cost, nothing to maintain.

### Option B — Move `client_unique_id` to a header (cheapest without Enterprise)

You own the client fork (`blitzstudios/react-native-code-push`), so the device id can be
sent as a request header instead of a query parameter, with the server reading the header
and falling back to the query parameter for older clients.

The remaining query string is then *exactly* the correct cache key, so a plain Cache Rule
("eligible for cache", "respect origin TTL") is correct with no custom key and no Worker.

Costs one client change plus a few lines on the server, and then has zero ongoing cost.

### Option C — Worker that normalises the cache key (works on any plan)

Be aware Workers bill per request, cached or not. At roughly 170M update checks/day this is
on the order of **$1.3–1.5k/month**, comparable to the App Service bill — so prefer A or B
unless you need a Worker anyway.

```js
const CACHE_PARAMS = ['deployment_key', 'app_version', 'label', 'package_hash', 'beta', 'is_companion'];
const ORIGIN = 'https://codepush-sleeper.azurewebsites.net';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const originUrl = ORIGIN + url.pathname + url.search;

    // Only GET update checks are cacheable; report_status and everything else passes through.
    if (request.method !== 'GET' || !url.pathname.endsWith('/update_check')) {
      return fetch(originUrl, request);
    }

    // Drop client_unique_id and sort, so devices differing only by identity collapse
    // onto one entry.
    const keyUrl = new URL(url.origin + url.pathname);
    for (const param of CACHE_PARAMS) {
      const value = url.searchParams.get(param);
      if (value !== null) keyUrl.searchParams.set(param, value);
    }
    keyUrl.searchParams.sort();

    const cacheKey = new Request(keyUrl.toString(), { method: 'GET' });
    const cache = caches.default;

    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const response = await fetch(originUrl, request);

    // The origin marks device-specific and degraded answers no-store; store only what
    // it permits.
    const cacheControl = response.headers.get('Cache-Control') || '';
    if (!response.ok || !cacheControl.includes('max-age') || cacheControl.includes('no-store')) {
      return response;
    }

    const cacheable = new Response(response.body, response);
    ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));
    return cacheable;
  },
};
```

## Client change

`SERVER_URL` in `clients/app-mobile/src/components/base/codepush.ts` points at the origin:

```ts
const SERVER_URL = 'https://codepush-sleeper.azurewebsites.net/';
```

Point it at a Cloudflare hostname. **Use a dedicated hostname** (for example
`codepush-api.sleepercdn.com`) rather than the existing `codepush.sleepercdn.com`, which
already fronts blob downloads — a separate hostname keeps the working download path
untouched.

Note the CodePush client sends `report_status/deploy`, `report_status/download` and
`notifyAppReady` to the same base URL, so the new hostname must route **all** of
`/v0.1/public/codepush/*` to the origin, while only `update_check` is cacheable.

## Rollout plan

1. Deploy the server change. On its own this only alters response headers; nothing caches
   it yet, so it is independently verifiable and safe.
2. Confirm headers directly against the origin:
   ```
   curl -sD - -o /dev/null "https://codepush-sleeper.azurewebsites.net/v0.1/public/codepush/update_check?deployment_key=<key>&app_version=<ver>"
   ```
   Expect `Cache-Control: public, max-age=30` and no `Set-Cookie`. With a ramping rollout
   in that deployment, expect `no-store`.
3. Stand up the hostname and cache rule. Verify `cf-cache-status` goes `MISS` then `HIT`,
   and that two requests differing **only** by `client_unique_id` both hit.
4. Verify a device on the newest label still gets `isAvailable: false` and that a device on
   an older label gets a diff URL whose hash matches its own — this is the case a wrong
   cache key would break.
5. Ship the client pointing at the new hostname. Origin request rate should fall by orders
   of magnitude; watch `Requests` on the App Service plan.

## Caveats

- **Release visibility lags by the TTL.** A newly published release can take up to 30s to
  appear at the edge. `invalidateCachedPackage` clears Redis but not Cloudflare. If that
  matters, purge the edge on release or accept the 30s window — the in-process microcache
  already introduces the same delay today.
- **Rollouts bypass the edge entirely**, so an in-progress rollout puts full load back on
  the origin. Avoid starting one during a known traffic spike.
- **CORS.** `routes/headers.ts` reflects the request `Origin` into
  `Access-Control-Allow-Origin`, which in principle makes responses vary by origin. Mobile
  clients send no `Origin`, so this is constant in practice. Adding `Vary: Origin` would be
  strictly correct but would defeat caching on Cloudflare; if browsers ever call
  `update_check`, give them a separate uncached hostname instead.
