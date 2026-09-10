import * as express from "express";
import * as queryString from "querystring";
import * as URL from "url";

export interface ParsedUpdateCheckRequest {
  deploymentKey: string;
  clientUniqueId: string;
  betaRequested: boolean;
  requestLabel: string;
  requestPackageHash: string;
  rawAppVersion: string;
  normalizedAppVersion: string;
  isCompanion: boolean;
  /**
   * The client's own rollout bucket, 0-99, or null when it didn't send one.
   * A client that supplies this lets the server decide rollout membership from
   * the request alone, which makes the answer shareable by a CDN. Without it the
   * bucket has to be derived from the device id and the answer is per-device.
   */
  rolloutBucket: number | null;
}

const ROLLOUT_BUCKET_COUNT = 100;

function parseRolloutBucket(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value >= ROLLOUT_BUCKET_COUNT) {
    return null;
  }

  return value;
}

export function normalizeAppVersion(version: string): string {
  if (!version) {
    return version;
  }

  if (/^\d+$/.test(version)) {
    return `${version}.0.0`;
  }

  if (/^\d+\.\d+([\+\-].*)?$/.test(version)) {
    const tagIndex = version.search(/[\+\-]/);
    if (tagIndex === -1) {
      return `${version}.0`;
    }

    return `${version.slice(0, tagIndex)}.0${version.slice(tagIndex)}`;
  }

  return version;
}

export function buildUpdateCheckCacheKey(originalUrl: string, cacheSchema?: string): string {
  const obj: any = URL.parse(originalUrl, /*parseQueryString*/ true);
  delete obj.query.client_unique_id;
  delete obj.query.beta;
  delete obj.query.package_hash;
  delete obj.query.label;
  // Redis caches the release list, which the bucket has no bearing on — the bucket
  // is applied afterwards when the response is built. Leaving it in would fragment
  // this cache once per bucket for no benefit. The CDN key is the opposite case: it
  // caches the finished response, so it must keep the bucket.
  delete obj.query.rollout_bucket;

  const rawAppVersion = obj.query.app_version;
  if (rawAppVersion) {
    obj.query.app_version = normalizeAppVersion(String(rawAppVersion));
  }

  if (cacheSchema) {
    obj.query.__cacheSchema = cacheSchema;
  }

  return obj.pathname + "?" + queryString.stringify(obj.query);
}

export function parseUpdateCheckRequest(req: express.Request): ParsedUpdateCheckRequest {
  const deploymentKey: string = String(req.query.deployment_key || "");
  const clientUniqueId: string = String(req.query.client_unique_id || "");
  const betaRequested: boolean = String(req.query.beta).toLowerCase() === "true";
  const requestLabel: string = String(req.query.label || "");
  const requestPackageHash: string = String(req.query.package_hash || "");
  const rawAppVersion: string = String(req.query.app_version || "");
  const normalizedAppVersion: string = normalizeAppVersion(rawAppVersion);
  const isCompanion: boolean = String(req.query.is_companion || "").toLowerCase() === "true";
  const rolloutBucket: number | null = parseRolloutBucket(req.query.rollout_bucket);

  return {
    deploymentKey,
    clientUniqueId,
    betaRequested,
    requestLabel,
    requestPackageHash,
    rawAppVersion,
    normalizedAppVersion,
    isCompanion,
    rolloutBucket,
  };
}
