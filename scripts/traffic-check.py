#!/usr/bin/env python3
"""One-shot health check across the CDN, the abuse signals, and the CodePush origin.

Answers the three questions worth asking at a glance:

  1. Is anyone hotlinking sleepercdn.com again? Any referer outside the known-good
     list that is pulling real bytes gets flagged.
  2. Has the upload abuse restarted? Two independent signals: the key their bot
     hammered (a single head-object, so it costs nothing) and a scan for the shapes
     the abuse produced -- extensionless keys, and oversized objects on the verbatim
     media path that skips re-encoding.
  3. Is the CodePush origin healthy? CPU, memory, requests, 5xx.

Exits non-zero if anything trips, so it can be wired to a cron or a watch loop.

Usage: scripts/traffic-check.py [minutes] [--deep]   (default 30 minutes)
       --deep scans 24 keyspace prefixes instead of 8; slower, better coverage.
"""

import json
import os
import re
import subprocess
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

ZONE = "b368aa39131fc35a783ef36da8982570"
BUCKET = "sleepercdn.com"
TOKEN = open(os.path.expanduser("~/.cf_token")).read().strip()

# The object their bot overwrote ~500x/min. Every payload re-encoded to the same
# 72-byte pixel and therefore to the same content-addressed key, so its mtime is a
# free canary for the whole operation.
CANARY_KEY = "uploads/36b27faece683480f2863b9ac73f0280.webp"

# Referer checking is scoped to /uploads/ rather than the whole host. Everything the
# abuse ever touched lived there, because that prefix is the only one a stranger can
# write to. /content/ is player photos written by internal sync jobs, and a long tail
# of fantasy-football sites hotlink those legitimately -- alerting on them is noise.
UPLOADS_PREFIX = "/uploads/"
KNOWN_GOOD = {"", "(none)", "sleeper.com", "sleeper.app", "sleepercdn.com", "www.sleeper.com"}
# A stranger has to pull more than this before it counts as hotlinking rather than noise.
REFERER_ALERT_GB_HR = 1.0

# The abuse arrived as extensionless keys; the fix now derives the extension from
# content, so any new one means uploads regressed. Oversized objects on the verbatim
# media path are the other shape to watch, since that path skips re-encoding.
BARE_KEY = re.compile(r"^uploads/[0-9a-f]{32}$")
VERBATIM_EXTENSIONS = (".mp4", ".m4a", ".aac")
OVERSIZE_BYTES = 1_500_000

MINUTES = 30
DEEP = "--deep" in sys.argv
for arg in sys.argv[1:]:
    if arg.isdigit():
        MINUTES = int(arg)

NOW = datetime.now(timezone.utc)
T0 = (NOW - timedelta(minutes=MINUTES)).strftime("%Y-%m-%dT%H:%M:%SZ")
T1 = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")
PER_HOUR = 60 / MINUTES

alerts = []


def graphql(query, variables):
    req = urllib.request.Request(
        "https://api.cloudflare.com/client/v4/graphql",
        data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        body = json.load(r)
    if body.get("errors"):
        print("  graphql error:", [e.get("message") for e in body["errors"]][:2])
    zones = (body.get("data") or {}).get("viewer", {}).get("zones") or [{}]
    return zones[0]


def cf(selection, extra_filter=""):
    q = """query($z:String!,$t0:Time!,$t1:Time!){viewer{zones(filter:{zoneTag:$z}){
      %s(limit:40,filter:{datetime_geq:$t0,datetime_leq:$t1%s},orderBy:[%s]){
        count sum{edgeResponseBytes} dimensions{%s}}}}}"""
    name, order, dims = selection
    return graphql(q % (name, extra_filter, order, dims),
                   {"z": ZONE, "t0": T0, "t1": T1}).get(name, []) or []


def check_hosts():
    rows = cf(("httpRequestsAdaptiveGroups", "sum_edgeResponseBytes_DESC",
               "clientRequestHTTPHost cacheStatus"))
    hosts = {}
    for r in rows:
        d = r["dimensions"]
        h = hosts.setdefault(d["clientRequestHTTPHost"], [0, 0.0, 0.0, {}])
        h[0] += r["count"]
        h[1] += r["sum"]["edgeResponseBytes"]
        if d["cacheStatus"] in ("miss", "expired", "dynamic", "none", "bypass"):
            h[2] += r["sum"]["edgeResponseBytes"]
        h[3][d["cacheStatus"]] = h[3].get(d["cacheStatus"], 0) + r["count"]

    print(f"=== hosts (last {MINUTES} min)")
    print(f"  {'host':<30} {'req/min':>10} {'GB/hr':>9} {'uncached GB/hr':>15}")
    for host, (count, total, uncached, _) in sorted(hosts.items(), key=lambda x: -x[1][1])[:6]:
        print(f"  {host[:29]:<30} {count/MINUTES:>10,.0f} "
              f"{total/1e9*PER_HOUR:>9.1f} {uncached/1e9*PER_HOUR:>15.2f}")

    mix = hosts.get("codepush-api." + BUCKET, [0, 0, 0, {}])[3]
    if mix:
        total = sum(mix.values())
        edge = sum(v for k, v in mix.items() if k in ("hit", "updating", "expired", "revalidated"))
        print(f"  codepush-api edge-served: {100*edge/max(total,1):.1f}% of {total/MINUTES:,.0f} req/min")


def check_referers():
    rows = cf(("httpRequestsAdaptiveGroups", "sum_edgeResponseBytes_DESC", "clientRefererHost"),
              f',clientRequestHTTPHost:"{BUCKET}",clientRequestPath_like:"{UPLOADS_PREFIX}%"')
    print(f"\n=== {BUCKET}{UPLOADS_PREFIX} referers (last {MINUTES} min)")
    if not rows:
        print("  (no traffic)")
        return
    for r in rows[:10]:
        ref = r["dimensions"]["clientRefererHost"] or "(none)"
        gb = r["sum"]["edgeResponseBytes"] / 1e9 * PER_HOUR
        bad = ref not in KNOWN_GOOD and gb >= REFERER_ALERT_GB_HR
        if bad:
            alerts.append(f"unrecognized referer {ref} pulling {gb:.2f} GB/hr from {UPLOADS_PREFIX}")
        print(f"  {ref[:33]:<34} {r['count']:>11,} {gb:>7.2f} GB/hr"
              f"{'   <-- UNRECOGNIZED' if bad else ''}")


def check_waf():
    rows = graphql("""query($z:String!,$t0:Time!,$t1:Time!){viewer{zones(filter:{zoneTag:$z}){
      firewallEventsAdaptiveGroups(limit:5,filter:{datetime_geq:$t0,datetime_leq:$t1},
      orderBy:[count_DESC]){count dimensions{action}}}}}""",
      {"z": ZONE, "t0": T0, "t1": T1}).get("firewallEventsAdaptiveGroups") or []
    print(f"\n=== WAF (last {MINUTES} min)")
    for r in rows:
        print(f"  {r['dimensions']['action']:<10} {r['count']:>9,}  ({r['count']/MINUTES:,.0f}/min)")


def check_canary():
    print("\n=== upload abuse canary")
    r = subprocess.run(["aws", "s3api", "head-object", "--bucket", BUCKET, "--key", CANARY_KEY],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        print("  canary key absent (fine - it may have been cleaned up)")
        return
    d = json.loads(r.stdout)
    age = (NOW - datetime.fromisoformat(d["LastModified"].replace("Z", "+00:00"))).total_seconds() / 60
    print(f"  last write to their key: {d['LastModified']}  ({age:,.0f} min ago)")
    if age < 15:
        alerts.append(f"upload bot appears active again (canary written {age:.0f} min ago)")
        print("  --> *** RESUMED ***")
    else:
        print("  --> quiet")


def check_new_shapes():
    prefixes = ["000", "1a7", "3f2", "7b9", "a45", "c1e", "e88", "f00"]
    if DEEP:
        prefixes += ["2b4", "5d6", "9e1", "b33", "4c8", "6f2", "8a0", "d55",
                     "36b", "07f", "2ff", "abc", "137", "4e4", "bb0", "f7c"]
    since = (NOW - timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%S")

    def listing(p):
        out = subprocess.run(
            ["aws", "s3api", "list-objects-v2", "--bucket", BUCKET, "--prefix", f"uploads/{p}",
             "--query", "Contents[].[Key,Size,LastModified]", "--output", "text"],
            capture_output=True, text=True, timeout=900).stdout
        rows = []
        for line in out.splitlines():
            f = line.split("\t")
            if len(f) >= 3 and f[2] > since:
                rows.append((f[0], int(f[1]), f[2]))
        return rows

    with ThreadPoolExecutor(max_workers=8) as ex:
        new = [x for sub in ex.map(listing, prefixes) for x in sub]

    scale = 4096 / len(prefixes)
    bare = [r for r in new if BARE_KEY.match(r[0])]
    oversized = [r for r in new if r[0].endswith(VERBATIM_EXTENSIONS) and r[1] > OVERSIZE_BYTES]
    # Size alone says nothing -- people upload real videos. The bypass worth catching is
    # a forged ftyp box wrapping something that is not media, so require the container to
    # actually contain media atoms before treating it as ordinary.
    forged = [r for r in oversized if not looks_like_real_media(r[0])]

    print(f"\n=== new objects in the last 6h ({len(prefixes)}/4096 of keyspace)")
    print(f"  total new           : {len(new):>5}  -> ~{int(len(new)*scale):,} fleet-wide")
    print(f"  extensionless       : {len(bare):>5}  (abuse shape; expected 0)")
    print(f"  oversized media     : {len(oversized):>5}  ({len(oversized)-len(forged)} verified real, "
          f"{len(forged)} unverifiable)")
    if bare:
        alerts.append(f"{len(bare)} extensionless objects appeared - upload classification may have regressed")
        for k, s, lm in bare[:3]:
            print(f"     {lm[11:19]}  {s/1e6:.2f}MB  {k}")
    if forged:
        alerts.append(f"{len(forged)} oversized objects claim a media container but hold no media atoms")
        for k, s, lm in forged[:3]:
            print(f"     {lm[11:19]}  {s/1e6:.2f}MB  {k}")


def looks_like_real_media(key):
    """True when the file carries actual media structure, not just a valid-looking header.

    A forged ftyp box costs eight bytes; a moov/trak/avc1 tree does not, so the atoms
    are what separate a real upload from the verbatim-path bypass.
    """
    try:
        req = urllib.request.Request(f"https://s3.amazonaws.com/{BUCKET}/{key}",
                                     headers={"Range": "bytes=0-2047"})
        with urllib.request.urlopen(req, timeout=30) as r:
            head = r.read()
    except Exception:
        return False
    if key.endswith(".aac"):
        return head[:1] == b"\xff" and (head[1] & 0xF0) == 0xF0
    return any(atom in head for atom in (b"moov", b"trak", b"mdia", b"avc1", b"mp4a"))


def azure(args):
    return subprocess.run(["az"] + args, capture_output=True, text=True, timeout=300)


def check_origin():
    print("\n=== CodePush origin")
    plan = azure(["appservice", "plan", "list", "--query", "[0].id", "-o", "tsv"]).stdout.strip()
    site = azure(["webapp", "list", "--query", "[0].id", "-o", "tsv"]).stdout.strip()
    if not plan or not site:
        print("  azure cli not logged in; skipping")
        return
    start = (NOW - timedelta(minutes=60)).strftime("%Y-%m-%dT%H:%M:%SZ")

    out = azure(["monitor", "metrics", "list", "--resource", plan,
                 "--metric", "CpuPercentage", "MemoryPercentage", "--interval", "PT5M",
                 "--aggregation", "Average", "Maximum",
                 "--start-time", start, "--end-time", T1, "-o", "json"]).stdout
    for m in (json.loads(out or "{}").get("value") or []):
        pts = [p for ts in m.get("timeseries", []) for p in ts.get("data", [])
               if p.get("average") is not None]
        if pts:
            avg = sum(p["average"] for p in pts) / len(pts)
            peak = max(p.get("maximum", 0) for p in pts)
            print(f"  {m['name']['value']:<18} avg {avg:>5.1f}%   peak-max {peak:>5.0f}%")
            if m["name"]["value"] == "CpuPercentage" and avg > 60:
                alerts.append(f"origin CPU averaging {avg:.0f}%")

    for metric in ("Requests", "Http5xx"):
        out = azure(["monitor", "metrics", "list", "--resource", site, "--metric", metric,
                     "--interval", "PT60M", "--aggregation", "Total",
                     "--start-time", start, "--end-time", T1, "-o", "json"]).stdout
        for m in (json.loads(out or "{}").get("value") or []):
            total = sum(p["total"] for ts in m.get("timeseries", []) for p in ts.get("data", [])
                        if p.get("total") is not None)
            print(f"  {metric:<18} {total:>12,.0f} in last hr  ({total/60:>8,.0f}/min)")
            if metric == "Http5xx" and total > 0:
                alerts.append(f"{total:,.0f} 5xx in the last hour")


def main():
    print(f"traffic check @ {T1}   window {MINUTES} min{'  (deep)' if DEEP else ''}\n")
    check_hosts()
    check_referers()
    check_waf()
    check_canary()
    check_new_shapes()
    check_origin()

    print("\n" + "=" * 58)
    if alerts:
        print("ALERT")
        for a in alerts:
            print(f"  - {a}")
    else:
        print("ALL CLEAR: no hotlinking, no upload abuse, origin healthy")
    return 1 if alerts else 0


if __name__ == "__main__":
    sys.exit(main())
