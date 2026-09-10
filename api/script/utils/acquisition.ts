// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.
import * as q from "q";
import * as semver from "semver";
import { CachedRelease, UpdateCheckCacheResponse, UpdateCheckRequest, UpdateCheckResponse } from "../types/rest-definitions";
import { Package, PackageHashToBlobInfoMap } from "../storage/storage";
import * as env from "../environment";
import * as URL from "url";
import * as rolloutSelector from "./rollout-selector";
import { CacheableResponse } from "../redis-manager";
import { normalizeAppVersion } from "./update-check-request";

function proxyBlobUrl(azureUrl: string): string {
  try {
    const proxyUrl = env.getUpdateCheckProxyUrl();
    if (!proxyUrl) {
      return azureUrl;
    }

    const parsedUrl = new URL.URL(azureUrl);
    const newUrl = new URL.URL(proxyUrl);
    newUrl.pathname = parsedUrl.pathname;
    newUrl.search = parsedUrl.search;

    return newUrl.toString();
  } catch (error) {
    console.warn('Failed to proxy blob URL:', error);
    return azureUrl;
  }
}

export function getUpdatePackageInfo(packageHistory: Package[], request: UpdateCheckRequest): UpdateCheckCacheResponse {
  const releases: CachedRelease[] = [];

  if (packageHistory && packageHistory.length) {
    const normalizedVersion = normalizeAppVersion(request.appVersion);

    for (let i = packageHistory.length - 1; i >= 0; i--) {
      const pkg = packageHistory[i];
      if (request.isCompanion || semver.satisfies(normalizedVersion, pkg.appVersion)) {
        releases.push(convertToCachedRelease(pkg));
      }
    }
  }

  return {
    releases,
  };
}

function convertToCachedRelease(pkg: Package): CachedRelease {
  return {
    appVersion: pkg.appVersion,
    blobUrl: pkg.blobUrl,
    description: pkg.description,
    isDisabled: pkg.isDisabled,
    isMandatory: pkg.isMandatory,
    label: pkg.label,
    packageHash: pkg.packageHash,
    size: pkg.size,
    rollout: pkg.rollout,
    rolloutHoldDurationMinutes: pkg.holdDurationMinutes,
    rolloutRampDurationMinutes: pkg.rampDurationMinutes,
    rolloutUploadTime: pkg.uploadTime,
  };
}

export function createUpdateInfoFromRelease(release: CachedRelease): UpdateCheckResponse {
  const response: UpdateCheckResponse = {
    downloadURL: proxyBlobUrl(release.blobUrl),
    description: release.description,
    isAvailable: !release.isDisabled,
    isMandatory: !!release.isMandatory,
    appVersion: release.appVersion,
    packageHash: release.packageHash,
    label: release.label,
    packageSize: release.size,
    updateAppVersion: false,
  };

  response.target_binary_range = release.appVersion;
  return response;
}

export function applyDiffPayload(
  updateInfo: UpdateCheckResponse,
  diffMap: PackageHashToBlobInfoMap | undefined,
  requestPackageHash: string
): void {
  if (!requestPackageHash || !diffMap) {
    return;
  }

  const diff = diffMap[requestPackageHash];
  if (diff) {
    updateInfo.downloadURL = proxyBlobUrl(diff.url);
    updateInfo.packageSize = diff.size;
  }
}

export function isClientPackage(release: CachedRelease, requestLabel: string, requestPackageHash: string): boolean {
  if (requestLabel) {
    return release.label === requestLabel;
  }

  return !!requestPackageHash && release.packageHash === requestPackageHash;
}

export function isClientSelectedForRollout(release: CachedRelease, clientUniqueId: string, releaseKey: string): boolean {
  if (!clientUniqueId || release.rollout === undefined || release.rollout === null) {
    return false;
  }

  const effectiveRollout = rolloutSelector.getEffectiveRollout({
    rollout: release.rollout,
    holdDurationMinutes: release.rolloutHoldDurationMinutes,
    rampDurationMinutes: release.rolloutRampDurationMinutes,
    uploadTime: release.rolloutUploadTime,
  });

  return rolloutSelector.isSelectedForRollout(clientUniqueId, effectiveRollout, releaseKey);
}

export function buildNoUpdateResponse(rawAppVersion: string, normalizedAppVersion: string): UpdateCheckResponse {
  return {
    isAvailable: false,
    appVersion: rawAppVersion || normalizedAppVersion,
    updateAppVersion: false,
  };
}

export type DiffMapFetcher = (packageHash: string) => q.Promise<PackageHashToBlobInfoMap>;

export async function buildUpdateCheckBody(
  response: CacheableResponse,
  clientUniqueId: string,
  betaRequested: boolean,
  requestLabel: string,
  requestPackageHash: string,
  rawAppVersion: string,
  normalizedAppVersion: string,
  requestIsCompanion: boolean,
  diffMapFetcher: DiffMapFetcher
): Promise<{ updateInfo: UpdateCheckResponse; varyByClient: boolean }> {
  const cachedResponseObject = <UpdateCheckCacheResponse>response.body;
  const releases = cachedResponseObject.releases || [];

  let selectedUpdate: UpdateCheckResponse = null;
  let selectedRelease: CachedRelease = null;
  let forceMandatory: boolean = false;
  let pendingMandatory: boolean = false;
  // Set once the answer depends on which device is asking, which only happens
  // while a rollout is still ramping. Everything else about the response is
  // determined by request parameters, so callers use this to decide whether a
  // shared cache is allowed to hold it.
  let varyByClient: boolean = false;

  for (const release of releases) {
    if (!release) {
      continue;
    }

    const isCurrentRelease = isClientPackage(release, requestLabel, requestPackageHash);

      if (isCurrentRelease && release.isDisabled) {
      continue;
    }

    if (isCurrentRelease) {
      if (selectedUpdate && selectedRelease) {
        await hydrateDiffPayloadForRelease(selectedUpdate, selectedRelease, requestPackageHash, diffMapFetcher);
        return finalizeUpdateCheckResponse(selectedUpdate, selectedRelease, forceMandatory, rawAppVersion, normalizedAppVersion, varyByClient);
      }

      const noUpdate = buildNoUpdateResponse(rawAppVersion, normalizedAppVersion);
      noUpdate.target_binary_range = noUpdate.appVersion;
      return { updateInfo: noUpdate, varyByClient };
    }

    if (release.isDisabled) {
      continue;
    }

    const releaseApplies =
      requestIsCompanion ||
      (!!normalizedAppVersion && normalizedAppVersion.length > 0 && semver.satisfies(normalizedAppVersion, release.appVersion));
    if (!releaseApplies) {
      continue;
    }

    if (selectedUpdate) {
      if (release.isMandatory) {
        forceMandatory = true;
      }

      continue;
    }

    const isRollout = rolloutSelector.isUnfinishedRollout(release.rollout);
    let updateInfo: UpdateCheckResponse = null;

    if (!isRollout) {
      updateInfo = createUpdateInfoFromRelease(release);
    } else {
      // Rollout bucketing reads clientUniqueId, so from here the answer is
      // specific to this device even when the beta flag short-circuits it.
      varyByClient = true;
      if (betaRequested || isClientSelectedForRollout(release, clientUniqueId, release.label || release.packageHash)) {
        updateInfo = createUpdateInfoFromRelease(release);
      }
    }

    if (updateInfo) {
      selectedUpdate = updateInfo;
      selectedRelease = release;
      forceMandatory = pendingMandatory || !!release.isMandatory;
      continue;
    }

    if (release.isMandatory) {
      pendingMandatory = true;
    }
  }

  if (selectedUpdate && selectedRelease) {
    await hydrateDiffPayloadForRelease(selectedUpdate, selectedRelease, requestPackageHash, diffMapFetcher);
    return finalizeUpdateCheckResponse(selectedUpdate, selectedRelease, forceMandatory, rawAppVersion, normalizedAppVersion, varyByClient);
  }

  const fallback = buildNoUpdateResponse(rawAppVersion, normalizedAppVersion);
  fallback.target_binary_range = fallback.appVersion;
  return { updateInfo: fallback, varyByClient };
}

async function hydrateDiffPayloadForRelease(
  updateInfo: UpdateCheckResponse,
  release: CachedRelease,
  requestPackageHash: string,
  diffMapFetcher: DiffMapFetcher
): Promise<void> {
  if (!requestPackageHash || !release) {
    return;
  }

  try {
    const diffMap = await diffMapFetcher(release.packageHash);
    if (diffMap) {
      applyDiffPayload(updateInfo, diffMap, requestPackageHash);
    }
  } catch (error) {
    console.warn("Failed to hydrate diff package map for updateCheck", error);
  }
}

function finalizeUpdateCheckResponse(
  updateInfo: UpdateCheckResponse,
  release: CachedRelease,
  forceMandatory: boolean,
  rawAppVersion: string,
  normalizedAppVersion: string,
  varyByClient: boolean
): { updateInfo: UpdateCheckResponse; varyByClient: boolean } {
  if (forceMandatory) {
    updateInfo.isMandatory = true;
  }

  const clientVersion = rawAppVersion || normalizedAppVersion;
  updateInfo.target_binary_range = clientVersion;
  updateInfo.appVersion = clientVersion;

  return { updateInfo, varyByClient };
}

