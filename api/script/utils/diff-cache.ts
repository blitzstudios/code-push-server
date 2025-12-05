import * as q from "q";
import * as redis from "../redis-manager";
import { CachedRelease } from "../types/rest-definitions";
import { Package, PackageHashToBlobInfoMap } from "../storage/storage";
import { Microcache } from "./microcache";
import { DiffMapFetcher } from "./acquisition";

const DIFFPACKAGE_MEM_TTL_MS: number = Number(process.env.DIFFPACKAGE_MEM_TTL_MS) || 5 * 60 * 1000;
// Memoizes per-release diff map lookups so burst traffic only hits Redis once per package hash.
const diffMapCache = new Microcache<q.Promise<PackageHashToBlobInfoMap>>(DIFFPACKAGE_MEM_TTL_MS);

export function createDiffMapFetcher(deploymentKey: string, redisManager: redis.RedisManager): DiffMapFetcher {
  if (!deploymentKey || !redisManager) {
    return () => q<PackageHashToBlobInfoMap>(null);
  }

  return (packageHash: string): q.Promise<PackageHashToBlobInfoMap> => {
    if (!packageHash) {
      return q<PackageHashToBlobInfoMap>(null);
    }

    const cacheKey = `${deploymentKey}:${packageHash}`;
    const cachedPromise = diffMapCache.get(cacheKey);
    if (cachedPromise) {
      return cachedPromise;
    }

    return redisManager.getPackageDiffMap(deploymentKey, packageHash).then((diffMap) => {
      const normalizedDiffMap = diffMap || null;
      const resolvedPromise = q<PackageHashToBlobInfoMap>(normalizedDiffMap);
      diffMapCache.set(cacheKey, resolvedPromise);
      return normalizedDiffMap;
    });
  };
}

export function primeDiffCacheForReleases(
  deploymentKey: string,
  releases: CachedRelease[] | undefined,
  packageLookup: Map<string, Package>,
  redisManager: redis.RedisManager
): q.Promise<void> {
  if (!redisManager || !deploymentKey || !releases || !releases.length) {
    return q<void>(null);
  }

  const diffCacheWrites: q.Promise<void>[] = [];
  releases.forEach((release) => {
    if (!release) {
      return;
    }

    const pkg = packageLookup.get(release.packageHash);
    const diffMap = pkg && pkg.diffPackageMap;
    const hasDiff = !!(diffMap && Object.keys(diffMap).length);

    if (hasDiff && diffMap) {
      diffCacheWrites.push(
        redisManager.setPackageDiffMap(deploymentKey, release.packageHash, diffMap).catch((error: any) => {
          console.warn("Failed to cache diff package map for updateCheck", error);
        })
      );
    }
  });

  return diffCacheWrites.length ? q.all(diffCacheWrites).then(() => {}) : q<void>(null);
}

