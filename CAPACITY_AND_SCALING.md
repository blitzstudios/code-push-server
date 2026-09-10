# Capacity and scaling

## Measured per-instance ceiling

From the 2026-09-10 incident window, comparing minutes where the fleet was healthy against
minutes where it was failing:

| Per-instance rate | Outcome |
| --- | --- |
| 435–455 req/sec | p95 8–9 ms, healthy |
| 516 req/sec | p95 143 ms — the knee |
| 624 req/sec | 10,239 platform 5xx |
| 646 req/sec | 101,520 platform 5xx |

So budget **~500 req/sec per instance** as the comfortable ceiling on `P1v3`, with failure
above ~600.

The evening peak that night was 5,172 req/sec platform-wide. At 8 instances that is 646
req/sec per instance — the fleet was over its ceiling during normal Sunday-evening traffic,
before any notification spike.

The binding constraint is the **rate of new connection arrivals**, not request throughput.
The same fleet later served 209k req/min at 8 ms p95. A broadcast notification produces
simultaneous TLS handshakes and accept-queue work, which is far more expensive per request
than answering a cached update check.

## Scale-unit limit

The plan cannot currently grow past **19 instances**:

```
Not enough available reserved instance servers to satisfy this request.
Currently 11 instances are available.
```

This is physical availability in the App Service scale unit, not a subscription quota, and
it fluctuates. Retrying later may allow more. If you need a guaranteed ceiling above this,
either enable [async scaling](https://aka.ms/async-scaling) or open a support request for
scale-unit capacity ahead of a known event.

## Autoscale

**Autoscale cannot protect against the failure mode we saw.** Azure Monitor autoscale rules
require a metric time window of at least 5 minutes and then apply a cooldown, so reaction
time is 5–10 minutes. The collapse on 2026-09-10 went from healthy to 1-second p95 inside a
single 15-second window. Reactive scaling will always lose that race.

What autoscale is genuinely good for here is the **predictable evening ramp** (56k req/min
at 16:00 PT rising to 209k req/min by 20:25 PT) and the cost of holding peak capacity
overnight. That is a scheduling problem, so use schedule-based profiles and treat metric
rules as a backstop.

Do not apply this while a spike is expected: a newly created setting evaluates immediately,
and if the active profile's minimum is below the current instance count it will scale **in**.

```bash
PLAN_ID=$(az appservice plan show -g codepush-server -n codepush-asp-sleeper --query id -o tsv)

# Off-peak default. Keep min at the current instance count until after the event.
az monitor autoscale create \
  --resource-group codepush-server \
  --resource "$PLAN_ID" \
  --name codepush-asp-autoscale \
  --min-count 8 --max-count 19 --count 8

# Backstop inside whichever profile is active.
az monitor autoscale rule create \
  --resource-group codepush-server --autoscale-name codepush-asp-autoscale \
  --condition "CpuPercentage > 55 avg 5m" --scale out 3 --cooldown 5

az monitor autoscale rule create \
  --resource-group codepush-server --autoscale-name codepush-asp-autoscale \
  --condition "CpuPercentage < 25 avg 15m" --scale in 2 --cooldown 15
```

Then add a recurring profile covering game windows, so capacity is already in place before
kickoff rather than chasing it:

```bash
az monitor autoscale profile create \
  --resource-group codepush-server --autoscale-name codepush-asp-autoscale \
  --name "game-nights" \
  --min-count 18 --max-count 19 --count 18 \
  --recurrence week thu sun mon --timezone "Pacific Standard Time" \
  --start 15:00 --end 23:59
```

Adjust the days to your actual broadcast schedule. Note that CPU is a weak proxy for the
real constraint (connection arrival rate), which App Service does not expose as a metric —
another reason to prefer schedules over reactive rules.

## Two Node workers per instance

`P1v3` has **2 vCPUs**, and the site runs a single Node process. Node executes JavaScript on
one thread, so roughly **half of every instance is unused**. Because the bottleneck is
per-process accept and TLS work on the main thread, running two workers should come close to
doubling per-instance capacity at no infrastructure cost — a better return than buying
instances, and it sidesteps the scale-unit limit.

The blessed Node image includes PM2, so this is a startup-command change:

```bash
az webapp config set -g codepush-server -n codepush-sleeper \
  --startup-file "pm2 start /home/site/wwwroot/bin/script/server.js -i 2 --no-daemon"
```

`-i 2` pins two workers. `-i max` would track the vCPU count, but pin it explicitly so a SKU
change doesn't silently multiply memory use.

### Caveats to check before shipping this

- **Startup risk.** An incorrect startup command means the site does not start at all.
  Verify on a slot or during a quiet window, never before an event.
- **Memory.** Each worker carries its own V8 heap. A single process currently settles at a
  ~1.2 GB working set, so budget ~2.4 GB of the 8 GB per instance. Comfortable, but confirm
  with `MemoryWorkingSet` after the change.
- **Per-process caches.** The `updateCheck` microcache and diff-map cache are per-process, so
  two workers hold two copies and miss slightly more often. With only 45 distinct
  `(deployment_key, app_version)` pairs this is negligible.
- **Redis connections.** `redis@2.4.2` opens one connection per client and there are two
  clients per process. 18 instances × 2 workers × 2 clients = 72 connections, against a
  1,000-connection limit on the Standard C1 cache. Fine, but it scales with both factors.
- **Health probe.** The background storage probe in `getHealthRouter` runs per process, so
  each instance issues two probes per interval instead of one. Harmless at a 15s interval.
- **Telemetry.** Both workers report the same `cloud_RoleInstance`, so per-instance
  Application Insights aggregations will cover two processes. Adjust any per-instance
  queries accordingly.

## After a traffic event

Scale back down. Holding 18 instances continuously is roughly $2,300/month against $1,022 at
8, at the `P1v3` Linux rate of $0.175/instance/hour in West US.

```bash
az appservice plan update -g codepush-server -n codepush-asp-sleeper --number-of-workers 8
```

If the schedule-based autoscale profile above is in place, this happens automatically.
