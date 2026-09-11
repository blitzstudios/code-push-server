#!/usr/bin/env python3
"""Report how much update_check traffic the CDN is absorbing.

Old clients have the origin URL compiled into their bundle, so they can never be
edge-cached. New clients go through Cloudflare and send a rollout_bucket. That gives
two disjoint populations we can count separately:

  new clients ~= Cloudflare edge requests for codepush-api.sleepercdn.com
  old clients ~= App Insights update_check requests with no rollout_bucket

Adoption is new / (new + old). Scale the App Service plan down only once adoption is
high and the measured origin load leaves room for the uncacheable remainder.

Usage: scripts/cdn-adoption.py [hours]      (default 1; App Insights retention is short)
"""

import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

ZONE = "b368aa39131fc35a783ef36da8982570"
CDN_HOST = "codepush-api.sleepercdn.com"
APP_INSIGHTS_ID = "fdeae2e2-7434-4303-be04-673a864f6629"
RESOURCE_GROUP = "codepush-server"
TOKEN_FILE = os.path.expanduser("~/.cf_token")

HOURS = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0
SINCE = datetime.now(timezone.utc) - timedelta(hours=HOURS)
SINCE_ISO = SINCE.strftime("%Y-%m-%dT%H:%M:%SZ")


def fail(msg):
    print(f"  ! {msg}")
    return None


def cloudflare_cache_breakdown():
    """Edge requests for the update_check hostname, grouped by cache status."""
    try:
        token = open(TOKEN_FILE).read().strip()
    except OSError:
        return fail(f"no Cloudflare token at {TOKEN_FILE}")

    query = """
    { viewer { zones(filter: {zoneTag: "%s"}) {
        httpRequestsAdaptiveGroups(
          limit: 100,
          filter: {datetime_geq: "%s", clientRequestHTTPHost: "%s"}
        ) { count dimensions { cacheStatus } }
    } } }
    """ % (ZONE, SINCE_ISO, CDN_HOST)

    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/graphql",
        data=json.dumps({"query": query}).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        body = json.load(r)

    if body.get("errors"):
        return fail("Cloudflare: " + "; ".join(e.get("message", "?") for e in body["errors"]))

    zones = body["data"]["viewer"]["zones"]
    if not zones:
        return fail("Cloudflare returned no zone (token may lack Analytics:Read)")

    out = {}
    for g in zones[0]["httpRequestsAdaptiveGroups"]:
        out[g["dimensions"]["cacheStatus"]] = g["count"]
    return out


def app_insights_old_clients():
    """update_check requests that did NOT send a rollout_bucket, i.e. pre-fix bundles."""
    kql = """
    requests
    | where timestamp > ago(%dm)
    | where url contains "update_check"
    | extend hasBucket = url contains "rollout_bucket="
    | summarize reqs=sum(itemCount) by hasBucket
    """ % int(HOURS * 60)

    proc = subprocess.run(
        ["az", "monitor", "app-insights", "query", "--app", APP_INSIGHTS_ID,
         "--analytics-query", kql, "-o", "json"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return fail("App Insights query failed: " + proc.stderr.strip()[:200])

    table = json.loads(proc.stdout)["tables"][0]
    cols = [c["name"] for c in table["columns"]]
    counts = {"with": 0, "without": 0}
    for row in table["rows"]:
        rec = dict(zip(cols, row))
        key = "with" if str(rec["hasBucket"]).lower() == "true" else "without"
        counts[key] += int(rec["reqs"] or 0)
    return counts


def app_service_requests():
    """Total requests actually reaching App Service (the load we pay compute for)."""
    proc = subprocess.run(
        ["az", "monitor", "metrics", "list",
         "--resource", f"/subscriptions/{subscription()}/resourceGroups/{RESOURCE_GROUP}"
                       f"/providers/Microsoft.Web/sites/codepush-sleeper",
         "--metric", "Requests", "--aggregation", "Total",
         "--start-time", SINCE_ISO, "--interval", "PT1M", "-o", "json"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        return fail("App Service metrics failed: " + proc.stderr.strip()[:200])

    data = json.loads(proc.stdout)["value"][0]["timeseries"][0]["data"]
    points = [p.get("total") or 0 for p in data]
    return {"total": sum(points), "peak_per_min": max(points) if points else 0}


def subscription():
    return subprocess.run(["az", "account", "show", "--query", "id", "-o", "tsv"],
                          capture_output=True, text=True).stdout.strip()


def main():
    print(f"\nCodePush CDN adoption - last {HOURS:g}h (since {SINCE_ISO})\n" + "=" * 62)

    cf = cloudflare_cache_breakdown()
    print("\n[ Cloudflare edge - %s ]" % CDN_HOST)
    if cf:
        total = sum(cf.values())
        served_at_edge = sum(v for k, v in cf.items() if k in ("hit", "stale", "updating"))
        went_to_origin = total - served_at_edge
        for status, n in sorted(cf.items(), key=lambda x: -x[1]):
            print("  %-12s %12s  %5.1f%%" % (status, f"{n:,}", 100 * n / max(1, total)))
        print("  %-12s %12s" % ("TOTAL", f"{total:,}"))
        if total:
            print("\n  served at edge : %s (%.1f%%)" % (f"{served_at_edge:,}", 100 * served_at_edge / total))
            print("  forwarded      : %s  <- origin load created by new clients" % f"{went_to_origin:,}")
        tiered = cf.get("tieredFill") or cf.get("CacheTieredFill")
        if tiered:
            print("  tiered fill    : %s" % f"{tiered:,}")
    else:
        print("  (no data - expected before the client release reaches devices)")

    ai = app_insights_old_clients()
    print("\n[ Origin - client population ]")
    if ai:
        old, new_seen = ai["without"], ai["with"]
        print("  no rollout_bucket (old bundle) : %12s  <- can never be cached" % f"{old:,}")
        print("  with rollout_bucket (new)      : %12s  (cache misses only)" % f"{new_seen:,}")
    else:
        old = None

    svc = app_service_requests()
    print("\n[ App Service - actual compute load ]")
    if svc:
        print("  total requests : %s" % f"{svc['total']:,.0f}")
        print("  peak req/min   : %s" % f"{svc['peak_per_min']:,.0f}")

    if cf and ai:
        cf_total = sum(cf.values())
        denom = cf_total + old
        print("\n[ Verdict ]")
        if denom:
            adoption = 100 * cf_total / denom
            print("  new-bundle adoption : %.1f%% of update_check traffic" % adoption)
            if adoption < 80:
                print("  -> DO NOT scale down yet; most of the fleet still bypasses the CDN.")
            else:
                print("  -> Adoption is high. Size instances against peak req/min above,")
                print("     targeting ~40%% CPU, and keep headroom for the uncacheable share.")
    print()


if __name__ == "__main__":
    main()
