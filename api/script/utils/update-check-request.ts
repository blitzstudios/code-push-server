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

  return {
    deploymentKey,
    clientUniqueId,
    betaRequested,
    requestLabel,
    requestPackageHash,
    rawAppVersion,
    normalizedAppVersion,
    isCompanion,
  };
}

