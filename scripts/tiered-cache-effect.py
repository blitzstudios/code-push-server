#!/usr/bin/env python3
"""Measure what the upper tier is absorbing, per hostname.

cacheStatus alone can't answer this: a lower-tier MISS satisfied by the upper tier
still reports MISS, so it looks identical to an origin fetch. cacheTieredFill is the
dimension that separates the two, which is what makes the tiered topology measurable.

Usage: scripts/tiered-cache-effect.py [minutes]   (default 60)
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

ZONE = "b368aa39131fc35a783ef36da8982570"
TOKEN = open(os.path.expanduser("~/.cf_token")).read().strip()
MINUTES = int(sys.argv[1]) if len(sys.argv) > 1 else 60
SINCE = (datetime.now(timezone.utc) - timedelta(minutes=MINUTES)).strftime("%Y-%m-%dT%H:%M:%SZ")

# Applied Smart Topology + Regional Tiered Cache at this instant.
CHANGE_AT = "2026-09-11T20:16:30Z"

HIT_STATUSES = {"hit", "stale", "updating"}


def graphql(query):
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/graphql",
        data=json.dumps({"query": query}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def fetch(dims):
    q = """
    { viewer { zones(filter: {zoneTag: "%s"}) {
        httpRequestsAdaptiveGroups(
          limit: 10000,
          filter: {datetime_geq: "%s"}
        ) { count dimensions { %s } }
    } } }
    """ % (ZONE, SINCE, dims)
    body = graphql(q)
    if body.get("errors"):
        return None, "; ".join(e.get("message", "?") for e in body["errors"])
    return body["data"]["viewer"]["zones"][0]["httpRequestsAdaptiveGroups"], None


def main():
    print(f"\nTiered cache effect - last {MINUTES}m (topology changed {CHANGE_AT})\n" + "=" * 70)

    # Is the tiered-fill dimension exposed at all?
    rows, err = fetch("clientRequestHTTPHost cacheStatus cacheTieredFill")
    tiered_available = err is None
    if not tiered_available:
        print(f"\n  cacheTieredFill unavailable ({err[:80]})")
        print("  falling back to cacheStatus only - cannot separate upper-tier fills\n")
        rows, err = fetch("clientRequestHTTPHost cacheStatus")
        if err:
            print("  failed:", err)
            return

    by_host = {}
    for r in rows:
        d = r["dimensions"]
        host = d["clientRequestHTTPHost"]
        agg = by_host.setdefault(host, {"total": 0, "hit": 0, "miss_tiered": 0, "miss_origin": 0, "uncacheable": 0})
        n = r["count"]
        agg["total"] += n
        status = (d.get("cacheStatus") or "").lower()
        if status in HIT_STATUSES:
            agg["hit"] += n
        elif status in ("miss", "expired", "revalidated"):
            if tiered_available and d.get("cacheTieredFill"):
                agg["miss_tiered"] += n
            else:
                agg["miss_origin"] += n
        else:
            agg["uncacheable"] += n

    for host, a in sorted(by_host.items(), key=lambda x: -x[1]["total"]):
        print(f"\n[ {host} ]  {a['total']:,} requests")
        print(f"  served from edge cache        {a['hit']:>10,}  {100*a['hit']/max(1,a['total']):5.1f}%")
        if tiered_available:
            print(f"  miss, filled by UPPER TIER   {a['miss_tiered']:>10,}  {100*a['miss_tiered']/max(1,a['total']):5.1f}%  <- absorbed, origin never saw it")
        label = "miss, went to ORIGIN" if tiered_available else "miss at edge (upper-tier fills indistinguishable)"
        print(f"  {label:<28} {a['miss_origin']:>10,}  {100*a['miss_origin']/max(1,a['total']):5.1f}%")
        print(f"  uncacheable (dynamic/bypass) {a['uncacheable']:>10,}  {100*a['uncacheable']/max(1,a['total']):5.1f}%")
        shielded = a["hit"] + a["miss_tiered"]
        cacheable = shielded + a["miss_origin"]
        if cacheable:
            qualifier = "" if tiered_available else " at the lower tier (upper tier absorbs an unknown share of the rest)"
            print(f"  --> {100*shielded/cacheable:.1f}% of cacheable traffic served from cache{qualifier}")

    print()


if __name__ == "__main__":
    main()
