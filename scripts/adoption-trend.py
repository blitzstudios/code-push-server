#!/usr/bin/env python3
"""Hourly adoption trend: how fast the fleet is moving onto the CDN-aware bundle.

new clients ~= Cloudflare edge update_check requests (old bundles can't reach that host)
old clients ~= origin update_check requests with no rollout_bucket

Usage: scripts/adoption-trend.py [hours]   (default 12)
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
HOURS = int(sys.argv[1]) if len(sys.argv) > 1 else 12
SINCE = datetime.now(timezone.utc) - timedelta(hours=HOURS)
SINCE_ISO = SINCE.strftime("%Y-%m-%dT%H:%M:%SZ")


def edge_by_hour():
    query = """
    { viewer { zones(filter: {zoneTag: "%s"}) {
        httpRequestsAdaptiveGroups(
          limit: 10000,
          filter: {datetime_geq: "%s", clientRequestHTTPHost: "%s",
                   clientRequestPath: "/v0.1/public/codepush/update_check"}
        ) { count dimensions { datetimeHour cacheStatus } }
    } } }
    """ % (ZONE, SINCE_ISO, CDN_HOST)
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/graphql",
        data=json.dumps({"query": query}).encode(),
        headers={"Authorization": "Bearer " + open(os.path.expanduser("~/.cf_token")).read().strip(),
                 "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        body = json.load(r)
    if body.get("errors"):
        print("  cloudflare:", body["errors"][0].get("message"))
        return {}, {}

    total, cached = {}, {}
    for g in body["data"]["viewer"]["zones"][0]["httpRequestsAdaptiveGroups"]:
        hour = g["dimensions"]["datetimeHour"][:13]
        total[hour] = total.get(hour, 0) + g["count"]
        if g["dimensions"]["cacheStatus"] in ("hit", "stale", "updating"):
            cached[hour] = cached.get(hour, 0) + g["count"]
    return total, cached


def origin_old_by_hour():
    kql = """
    requests
    | where timestamp > ago(%dh)
    | where url contains "update_check"
    | where url !contains "rollout_bucket="
    | summarize reqs=sum(itemCount) by bin(timestamp, 1h)
    """ % HOURS
    # Without an explicit --end-time the CLI narrows the timespan to roughly the first
    # hour after --start-time and silently returns almost nothing.
    end_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    proc = subprocess.run(
        ["az", "monitor", "app-insights", "query", "--app", APP_INSIGHTS_ID,
         "--start-time", SINCE_ISO, "--end-time", end_iso,
         "--analytics-query", kql, "-o", "json"],
        capture_output=True, text=True)
    if proc.returncode != 0:
        print("  app insights:", proc.stderr.strip()[:150])
        return {}
    table = json.loads(proc.stdout)["tables"][0]
    cols = [c["name"] for c in table["columns"]]
    out = {}
    for row in table["rows"]:
        rec = dict(zip(cols, row))
        out[rec["timestamp"][:13]] = int(rec["reqs"] or 0)
    return out


def main():
    edge_total, edge_cached = edge_by_hour()
    old = origin_old_by_hour()

    print(f"\nAdoption trend - last {HOURS}h\n" + "=" * 74)
    print("  %-14s %12s %12s %9s %10s" % ("hour UTC", "new (edge)", "old (origin)", "adoption", "edge hit%"))

    for hour in sorted(set(edge_total) | set(old)):
        new = edge_total.get(hour, 0)
        o = old.get(hour, 0)
        if new + o == 0:
            continue
        hit = 100 * edge_cached.get(hour, 0) / new if new else 0
        print("  %-14s %12s %12s %8.1f%% %9.1f%%" % (
            hour[5:] + "Z", f"{new:,}", f"{o:,}", 100 * new / (new + o), hit))
    print()


if __name__ == "__main__":
    main()
