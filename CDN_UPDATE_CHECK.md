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

- `Cache-Control: public, s-maxage=30, max-age=0` when the answer is determined entirely by
  the parameters above. `s-maxage` targets shared caches only; `max-age=0` keeps devices
  revalidating exactly as they did before, so the edge window isn't stacked on top of a
  second device-side window.
- `Cache-Control: no-store` when a ramping rollout made the answer device-specific, and for
  degraded (storage-timeout) answers that don't reflect real deployment state.

Cloudflare only has to respect origin TTLs. A rollout automatically falls back to today's
behaviour instead of being silently wrong.

The TTL is controlled by `UPDATECHECK_EDGE_TTL_SECONDS` (default 30, `0` disables edge
caching entirely — a single app-setting change is enough to take the edge out of the path).

## Prerequisites (all done)

- **camelCase query parameters.** The server used to accept `deploymentKey` alongside
  `deployment_key` (and so on for every parameter). Nothing sent them — zero occurrences in
  870M requests over 31 days — but while the origin still honoured them, a request could
  reach the origin carrying a parameter the cache key didn't see. Removed, along with the
  unused legacy `/updateCheck` route (40 hits in 31 days, all from one 10-minute manual
  session, all using snake_case).

- **`Cache-Control: no-cache` on every response.** `routes/headers.ts` set this globally;
  `sendUpdateCheckResponse` now overrides it per response.
- **`ARRAffinity` cookie.** App Service session affinity attached a `Set-Cookie` to every
  response, and Cloudflare will not cache a response carrying `Set-Cookie`. Affinity is
  disabled (`clientAffinityEnabled: false`) — it was useless for a stateless API and was
  also skewing load distribution.

## Implementation: Enterprise custom cache key

`sleepercdn.com` is on Enterprise, so this is a Cache Rule with a custom cache key. No
Worker, no per-request cost, nothing to maintain.

Cloudflare's default cache key is the **full query string**, which includes
`client_unique_id` and would give one cache entry per device. The custom key has to remove
it.

### Exclude the device id, don't include an allowlist

The server reads exactly six query parameters, all snake_case: `deployment_key`,
`app_version`, `label`, `package_hash`, `is_companion`, `beta`, plus `client_unique_id`.
(Support for camelCase spellings was removed — it was dead, with zero occurrences across
870M requests in 31 days.)

Cloudflare offers both `include` (keep only the listed params) and `exclude` (keep
everything except the listed params). Either is correct today. **Use `exclude`**, because
the two fail differently as the API evolves:

| Approach | If a parameter is added later and the rule isn't updated |
| --- | --- |
| `include` allowlist | New param drops out of the key — **wrong answer served**, silently |
| `exclude` denylist | New param stays in the key — lower hit rate, still correct |

An allowlist has to be kept in sync with the server forever, and the penalty for forgetting
is serving one client another client's answer. A denylist only has to name the parameters
that are per-device, and forgetting shows up as a hit-rate regression in metrics rather
than as incorrect updates.

`client_unique_id` is the only per-device parameter, so excluding it alone yields exactly
the ~287 entry cardinality measured above.

### The rule

**Append, do not replace.** A `PUT` to a phase entrypoint overwrites *every* rule in that
phase, which would remove the cache rules already fronting blob downloads on this zone.
Inspect first, then `POST` a single rule.

```bash
ZONE_ID=<sleepercdn.com zone id>

# 1. What is already in the cache phase?
curl -s \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets/phases/http_request_cache_settings/entrypoint" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  | jq '{ruleset: .result.id, rules: [.result.rules[]? | {description, expression}]}'
```

If that returns 404 the phase has no ruleset yet, and a `PUT` with a `"rules": [...]` array
is the way to create it. Otherwise take the ruleset id and append:

```bash
# 2. Append the update_check rule.
RULESET_ID=<ruleset id from step 1>

curl -X POST \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets/$RULESET_ID/rules" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Cache CodePush update_check, keyed without the device id",
    "expression": "(http.host eq \"codepush-api.sleepercdn.com\" and starts_with(http.request.uri.path, \"/v0.1/public/codepush/update_check\"))",
    "action": "set_cache_settings",
    "action_parameters": {
      "cache": true,
      "edge_ttl":    { "mode": "respect_origin" },
      "browser_ttl": { "mode": "respect_origin" },
      "cache_key": {
        "custom_key": {
          "query_string": {
            "exclude": { "list": ["client_unique_id"] }
          }
        }
      }
    }
  }'
```

Rules in a phase evaluate in order and the last match wins, so confirm no later rule
overrides these cache settings for the same path.

`respect_origin` is what makes the origin's `s-maxage=30` / `no-store` authoritative, so a
ramping rollout bypasses the edge automatically.

Everything else on `/v0.1/public/codepush/*` (the `report_status` endpoints) must route to
the origin but stay **uncached** — they are POSTs and will not match this rule, but confirm
no broader cache rule catches them.

## Applied configuration (live as of 2026-09-10)

Zone `sleepercdn.com` = `b368aa39131fc35a783ef36da8982570` (Enterprise).

| Piece | Value |
| --- | --- |
| DNS `CNAME codepush-api` | → `codepush-sleeper.azurewebsites.net`, proxied |
| DNS `TXT asuid.codepush-api` | Azure custom-domain ownership proof |
| App Service hostname | `codepush-api.sleepercdn.com`, SNI SSL |
| Certificate | App Service Managed, GeoTrust TLS RSA CA G1, expires 2027-03-10 |
| Cache rule | ruleset `ed50c5861deb45f39d0a3ef09eb931d0`, rule appended 6th of 6 |
| Config rule | ruleset `38b6f85ca3fb467696a6cc699cc91727`, rule `71bda9865fcc46699e396d0da6075548` |

### The zone is on Flexible SSL, and must stay that way

Cloudflare connects to origins over plain HTTP on this zone. That is not an oversight:
`codepush.sleepercdn.com` is a custom domain on Azure Blob Storage, and Blob Storage only
serves its own `*.blob.core.windows.net` certificate, so a custom domain cannot terminate
HTTPS at that origin. Switching the zone to Full (strict) would break bundle downloads.

App Service has `httpsOnly: true`, so with Flexible the origin answered every proxied
request with a 301 to the same URL and clients looped forever. The fix is a **Configuration
Rule** scoping `ssl: strict` to this one hostname, leaving the rest of the zone on Flexible:

```bash
curl -X PUT \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/rulesets/phases/http_config_settings/entrypoint" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"rules":[{
    "description": "Full (strict) TLS to the CodePush API origin only.",
    "expression": "(http.host eq \"codepush-api.sleepercdn.com\")",
    "action": "set_config",
    "action_parameters": { "ssl": "strict" },
    "enabled": true
  }]}'
```

This needs `Config Rules:Edit` on the API token, which is separate from `Cache Rules:Edit`.

### Verification results

Run against the live edge on 2026-09-10, comparing every answer against origin truth:

| Test | Result |
| --- | --- |
| Repeat request | `MISS` → `HIT` → `HIT` |
| Three distinct `client_unique_id` | All `HIT`, identical body — one origin fetch serves every device |
| Two different `deployment_key` | Separate entries, each got its own correct body |
| `package_hash` present vs absent | Separate entries, correct bodies (diff bundles safe) |
| `label` v763 vs v700 | Separate entries, correct bodies |
| `app_version` 151.1 vs 150.0 | Separate entries, correct bodies |
| 400 malformed request | `BYPASS`, not cached |
| `report_status` POST | `DYNAMIC`, not cached |
| TTL | `age: 0` → `age: 10` → `EXPIRED` at 30s |
| 200 unique devices | 199 `HIT`, 1 `MISS` — **99% of requests never reached the origin** |

Query parameter *order* is not normalised: reordering the same parameters produces a second
cache entry. The acquisition SDK emits them in a fixed order so this costs nothing in
practice, and the failure mode is a lower hit rate rather than a wrong answer.

## Rollouts decide how much of this actually helps

A release publishes with `hold=120min, ramp=360min` by default, and pushes happen several
times a day, so a rollout is active most of the time. That matters because a partial
rollout buckets on the device id, which makes the answer per-device and therefore
`no-store`. Three phases:

| Phase | Effective rollout | Shareable |
| --- | --- | --- |
| Beta hold, first 2h | 0% — only beta clients, decided without the device id | Yes |
| Ramp, next 6h | 0→100%, bucketed per device | **No**, unless the client sends `rollout_bucket` |
| After ~8h | 100% — everyone gets the same answer | Yes |

A release published with a percentage but **no** ramp duration never reaches 100 on its
own, so it stays per-device until someone patches it to 100%.

Two consequences worth planning around:

- **Publishing within ~8 hours of a game leaves the origin exposed**, because the ramp will
  still be running when the herd arrives. The cheapest mitigation is a pre-game release
  freeze; no code required.
- **`rollout_bucket` is what makes a live ramp cacheable.** The client computes its own
  bucket and sends it, so the server never has to look at the device id. The
  acquisition SDK builds this query in plain JavaScript that is bundled into the RN
  bundle, so shipping it is a CodePush release rather than an App Store one.

The client should derive the bucket from the device id salted with **its current label**:
that keeps it stable for the duration of a rollout (a device's label doesn't change until
it installs) while reshuffling the cohort every release, so the same users aren't
permanently the canaries. Use 5% granularity — 20 buckets multiply the cache key space by
20, and the hot set during a game is only a handful of base keys. Coarser distorts the
ramp, because `bucket < rollout` rounds up: with 10% buckets an intended 5% rollout
actually reaches 10% of devices.

Clients that send nothing keep today's behaviour and get `no-store`, so adoption is
incremental.

### Smart Tiered Cache is off

Each Cloudflare PoP fetches independently, so origin load is roughly
`distinct keys × active PoPs × (60 / TTL)` per minute rather than `distinct keys × 2`.
With ~287 keys that is still a large reduction, but enabling Smart Tiered Cache would
collapse it further by having lower-tier PoPs fetch from an upper tier. It is a zone-wide
setting, so it also affects blob downloads — likely to help them too, but it should be
changed deliberately rather than as part of this work.

## Alternatives (not needed on Enterprise)

Recorded in case the zone or plan changes.

### Move `client_unique_id` to a header

You own the client fork (`blitzstudios/react-native-code-push`), so the device id can be
sent as a request header instead of a query parameter, with the server reading the header
and falling back to the query parameter for older clients.

The remaining query string is then *exactly* the correct cache key, so a plain Cache Rule
("eligible for cache", "respect origin TTL") is correct with no custom key and no Worker.

Costs one client change plus a few lines on the server, and then has zero ongoing cost.

### Worker that normalises the cache key (works on any plan)

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
4. Verify the cache key still separates what it must. These are the cases a wrong key
   breaks, in descending order of severity:
   - Two different `deployment_key` values must **never** share an entry. Request each and
     confirm the payloads differ. This is the one that would serve one app another app's
     bundle.
   - A device on the newest label gets `isAvailable: false`, while a device on an older
     label gets an update whose diff URL matches its own `package_hash`.
   - Two different `app_version` values return their own `target_binary_range`.
5. Confirm a deployment with an in-progress rollout returns `Cache-Control: no-store` and
   reports `cf-cache-status: BYPASS`, so rollout bucketing is never shared between devices.
6. Ship the client pointing at the new hostname. Origin request rate should fall by orders
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
