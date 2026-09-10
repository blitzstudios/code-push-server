// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as express from "express";
import * as semver from "semver";

import * as utils from "../utils/common";
import * as acquisitionUtils from "../utils/acquisition";
import * as errorUtils from "../utils/rest-error-handling";
import * as redis from "../redis-manager";
import * as restHeaders from "../utils/rest-headers";
import * as storageTypes from "../storage/storage";
import { UpdateCheckCacheResponse, UpdateCheckRequest } from "../types/rest-definitions";
import * as validationUtils from "../utils/validation";

import * as q from "q";
import Promise = q.Promise;
import { Microcache } from "../utils/microcache";
import {
  ParsedUpdateCheckRequest,
  buildUpdateCheckCacheKey,
  normalizeAppVersion,
  parseUpdateCheckRequest,
} from "../utils/update-check-request";
import { createDiffMapFetcher, primeDiffCacheForReleases } from "../utils/diff-cache";
import { SendUpdateCheckOptions, sendUpdateCheckResponse } from "../utils/update-check-response";

const METRICS_BREAKING_VERSION = "1.5.2-beta";

// Small per-process microcache to smooth burst traffic for updateCheck.
// Holds the fully cacheable response object for a short time window.
const UPDATECHECK_MEM_TTL_MS: number = Number(process.env.UPDATECHECK_MEM_TTL_MS) || 30000;
const updateCheckMicrocache = new Microcache<redis.CacheableResponse>(UPDATECHECK_MEM_TTL_MS);
const UPDATECHECK_CACHE_SCHEMA_VERSION = "v2";

// Upper bound on the storage lookup behind a cache miss. Clients block app
// startup on this call, so a slow lookup has to become a cheap "no update"
// answer rather than a hung request the user resolves by force-quitting.
const UPDATECHECK_STORAGE_TIMEOUT_MS: number = Number(process.env.UPDATECHECK_STORAGE_TIMEOUT_MS) || 10000;

const HEALTH_PROBE_INTERVAL_MS: number = Number(process.env.HEALTH_PROBE_INTERVAL_MS) || 15000;
const HEALTH_PROBE_TIMEOUT_MS: number = Number(process.env.HEALTH_PROBE_TIMEOUT_MS) || 5000;
const HEALTH_FAILURE_THRESHOLD: number = Number(process.env.HEALTH_FAILURE_THRESHOLD) || 3;

export interface AcquisitionConfig {
  storage: storageTypes.Storage;
  redisManager: redis.RedisManager;
}

function createResponseUsingStorage(
  req: express.Request,
  res: express.Response,
  storage: storageTypes.Storage,
  redisManager: redis.RedisManager
): Promise<redis.CacheableResponse> {
  const deploymentKey: string = String(req.query.deploymentKey || req.query.deployment_key);
  const appVersion: string = String(req.query.appVersion || req.query.app_version);
  const packageHash: string = String(req.query.packageHash || req.query.package_hash);
  const isCompanion: string = String(req.query.isCompanion || req.query.is_companion);

  const updateRequest: UpdateCheckRequest = {
    deploymentKey: deploymentKey,
    appVersion: appVersion,
    packageHash: packageHash,
    isCompanion: isCompanion && isCompanion.toLowerCase() === "true",
    label: String(req.query.label),
  };

  let originalAppVersion: string | undefined;
  const normalizedAppVersion = normalizeAppVersion(updateRequest.appVersion);
  if (normalizedAppVersion !== updateRequest.appVersion) {
    originalAppVersion = updateRequest.appVersion;
    updateRequest.appVersion = normalizedAppVersion;
  }

  if (validationUtils.isValidUpdateCheckRequest(updateRequest)) {
    return storage.getPackageHistoryFromDeploymentKey(updateRequest.deploymentKey).then((packageHistory: storageTypes.Package[]) => {
      const updateObject: UpdateCheckCacheResponse = acquisitionUtils.getUpdatePackageInfo(packageHistory, updateRequest);

      const packageLookup = new Map<string, storageTypes.Package>();
      for (const pkg of packageHistory || []) {
        if (pkg && pkg.packageHash) {
          packageLookup.set(pkg.packageHash, pkg);
        }
      }

      const cacheableResponse: redis.CacheableResponse = {
        statusCode: 200,
        body: updateObject,
      };

      return primeDiffCacheForReleases(deploymentKey, updateObject.releases, packageLookup, redisManager).then(() => cacheableResponse);
    });
  } else {
    if (!validationUtils.isValidKeyField(updateRequest.deploymentKey)) {
      errorUtils.sendMalformedRequestError(
        res,
        "An update check must include a valid deployment key - please check that your app has been " +
          "configured correctly. To view available deployment keys, run 'code-push-standalone deployment ls <appName> -k'."
      );
    } else if (!validationUtils.isValidAppVersionField(updateRequest.appVersion)) {
      errorUtils.sendMalformedRequestError(
        res,
        "An update check must include a binary version that conforms to the semver standard (e.g. '1.0.0'). " +
          "The binary version is normally inferred from the App Store/Play Store version configured with your app."
      );
    } else {
      errorUtils.sendMalformedRequestError(
        res,
        "An update check must include a valid deployment key and provide a semver-compliant app version."
      );
    }

    return q<redis.CacheableResponse>(null);
  }
}

export function getHealthRouter(config: AcquisitionConfig): express.Router {
  const storage: storageTypes.Storage = config.storage;
  const redisManager: redis.RedisManager = config.redisManager;
  const router: express.Router = express.Router();

  // Storage is the source of truth and must be reachable to serve requests, so
  // sustained storage failure is fatal (returns unhealthy and lets the load
  // balancer pull this instance). Redis is a best-effort cache: if it's
  // unreachable we can still serve update checks from storage, so treat it as
  // degraded rather than failing the health check and taking every instance out
  // of rotation.
  //
  // The probe runs on a timer rather than inside the request handler. Doing the
  // storage round trip per request couples liveness to whatever is slowing the
  // instance down, so a fleet-wide stall fails every probe at once and the
  // instances that are still serving from cache get pulled along with the rest.
  // Reading a cached verdict keeps /health O(1), and requiring consecutive
  // failures stops one slow round trip from evicting a healthy instance.
  let consecutiveStorageFailures: number = 0;
  let lastStorageError: Error = null;

  const probeStorage = (): void => {
    storage
      .checkHealth()
      .timeout(HEALTH_PROBE_TIMEOUT_MS, "Storage health check timed out")
      .then(() => {
        consecutiveStorageFailures = 0;
        lastStorageError = null;
      })
      .catch((error: Error) => {
        consecutiveStorageFailures++;
        lastStorageError = error;
        console.warn(`Storage health probe failed (${consecutiveStorageFailures} consecutive)`, error);
      })
      .then(() => {
        return redisManager
          .checkHealth()
          .timeout(HEALTH_PROBE_TIMEOUT_MS, "Redis health check timed out")
          .catch((error: Error) => {
            console.warn("Redis health check failed; serving in cache-degraded mode", error);
          });
      })
      .done();
  };

  probeStorage();
  const probeTimer = setInterval(probeStorage, HEALTH_PROBE_INTERVAL_MS);
  probeTimer.unref();

  router.get("/health", (req: express.Request, res: express.Response, next: (err?: any) => void): any => {
    if (consecutiveStorageFailures >= HEALTH_FAILURE_THRESHOLD) {
      errorUtils.sendUnknownError(res, lastStorageError || new Error("Storage is unreachable"), next);
      return;
    }

    res.status(200).send("Healthy");
  });

  return router;
}

export function getAcquisitionRouter(config: AcquisitionConfig): express.Router {
  const storage: storageTypes.Storage = config.storage;
  const redisManager: redis.RedisManager = config.redisManager;
  const router: express.Router = express.Router();

  const updateCheck = function (req: express.Request, res: express.Response, next: (err?: any) => void) {
    const parsedRequest: ParsedUpdateCheckRequest = parseUpdateCheckRequest(req);
    const deploymentKey: string = parsedRequest.deploymentKey;
    const key: string = redis.Utilities.getDeploymentKeyHash(deploymentKey);
    const url: string = buildUpdateCheckCacheKey(req.originalUrl, UPDATECHECK_CACHE_SCHEMA_VERSION);
    const memCacheKey: string = key + "|" + url;
    let fromCache: boolean = true;
    let degraded: boolean = false;
    let redisError: Error;
    const diffMapFetcher = createDiffMapFetcher(deploymentKey, redisManager);

    const responseOptionsBase: Omit<SendUpdateCheckOptions, "fromCache"> = {
      res,
      clientUniqueId: parsedRequest.clientUniqueId,
      betaRequested: parsedRequest.betaRequested,
      requestLabel: parsedRequest.requestLabel,
      requestPackageHash: parsedRequest.requestPackageHash,
      rawAppVersion: parsedRequest.rawAppVersion,
      normalizedAppVersion: parsedRequest.normalizedAppVersion,
      isCompanion: parsedRequest.isCompanion,
      diffMapFetcher,
    };

    const memValue = updateCheckMicrocache.get(memCacheKey);
    if (memValue) {
      sendUpdateCheckResponse(memValue, { ...responseOptionsBase, fromCache: true })
        .catch((error: any) => next(error));
      return;
    }

    redisManager
      .getCachedResponse(key, url)
      .catch((error: Error) => {
        // Store the redis error to be thrown after we send response.
        redisError = error;
        return q<redis.CacheableResponse>(null);
      })
      .then((cachedResponse: redis.CacheableResponse) => {
        fromCache = !!cachedResponse;
        if (cachedResponse) {
          return q<redis.CacheableResponse>(cachedResponse);
        }

        return createResponseUsingStorage(req, res, storage, redisManager)
          .timeout(UPDATECHECK_STORAGE_TIMEOUT_MS, "updateCheck storage lookup timed out")
          .catch((error: any): redis.CacheableResponse => {
            // createResponseUsingStorage answers malformed requests itself.
            if (res.headersSent) {
              return null;
            }

            // "No update available" is safe and idempotent: the client walks
            // into the app and picks the release up on its next check. The
            // alternative is a failed startup, which users resolve by
            // force-quitting and relaunching straight back into this path.
            console.warn("updateCheck storage lookup failed; serving no-update response", error);
            degraded = true;
            return { statusCode: 200, body: { releases: [] } };
          });
      })
      .then((response: redis.CacheableResponse) => {
        if (!response) {
          return q<void>(null);
        }

        return sendUpdateCheckResponse(response, { ...responseOptionsBase, fromCache, shareable: !degraded })
          .then(() => {
            // A degraded answer isn't the real state of the deployment, so it
            // must not reach either cache tier.
            if (degraded) {
              return;
            }

            updateCheckMicrocache.set(memCacheKey, response);
            if (!fromCache) {
              return redisManager.setCachedResponse(key, url, response).catch((error: any) => {
                console.warn("Failed to set updateCheck cache", error);
              });
            }
          });
      })
      .then(() => {
        if (redisError) {
          console.warn("Redis cache error in updateCheck", redisError);
        }
      })
      .catch((error: storageTypes.StorageError) => errorUtils.restErrorHandler(res, error, next))
      .done();
  };

  const reportStatusDeploy = function (req: express.Request, res: express.Response, next: (err?: any) => void) {
    const deploymentKey = req.body.deploymentKey || req.body.deployment_key;
    const appVersion = req.body.appVersion || req.body.app_version;
    const previousDeploymentKey = req.body.previousDeploymentKey || req.body.previous_deployment_key || deploymentKey;
    const previousLabelOrAppVersion = req.body.previousLabelOrAppVersion || req.body.previous_label_or_app_version;
    const clientUniqueId = req.body.clientUniqueId || req.body.client_unique_id;

    if (!deploymentKey || !appVersion) {
      return errorUtils.sendMalformedRequestError(res, "A deploy status report must contain a valid appVersion and deploymentKey.");
    } else if (req.body.label) {
      if (!req.body.status) {
        return errorUtils.sendMalformedRequestError(res, "A deploy status report for a labelled package must contain a valid status.");
      } else if (!redis.Utilities.isValidDeploymentStatus(req.body.status)) {
        return errorUtils.sendMalformedRequestError(res, "Invalid status: " + req.body.status);
      }
    }

    const sdkVersion: string = restHeaders.getSdkVersion(req);
    if (semver.valid(sdkVersion) && semver.gte(sdkVersion, METRICS_BREAKING_VERSION)) {
      // Respond immediately; perform metrics updates asynchronously to avoid blocking under burst traffic
      res.sendStatus(200);

      // If previousDeploymentKey not provided, assume it is the same deployment key.
      let redisUpdatePromise: q.Promise<void>;

      if (req.body.label && req.body.status === redis.DEPLOYMENT_FAILED) {
        redisUpdatePromise = redisManager.incrementLabelStatusCount(deploymentKey, req.body.label, req.body.status);
      } else {
        const labelOrAppVersion: string = req.body.label || appVersion;
        redisUpdatePromise = redisManager.recordUpdate(
          deploymentKey,
          labelOrAppVersion,
          previousDeploymentKey,
          previousLabelOrAppVersion
        );
      }

      redisUpdatePromise
        .then(() => {
          if (clientUniqueId) {
            return redisManager.removeDeploymentKeyClientActiveLabel(previousDeploymentKey, clientUniqueId);
          }
        })
        .catch((error: any) => {
          console.warn("Failed to record deploy metric", error);
        })
        .done();
    } else {
      if (!clientUniqueId) {
        return errorUtils.sendMalformedRequestError(
          res,
          "A deploy status report must contain a valid appVersion, clientUniqueId and deploymentKey."
        );
      }

      // Respond immediately; perform legacy SDK metrics updates asynchronously
      res.sendStatus(200);

      redisManager
        .getCurrentActiveLabel(deploymentKey, clientUniqueId)
        .then((currentVersionLabel: string) => {
          if (req.body.label && req.body.label !== currentVersionLabel) {
            return redisManager.incrementLabelStatusCount(deploymentKey, req.body.label, req.body.status).then(() => {
              if (req.body.status === redis.DEPLOYMENT_SUCCEEDED) {
                return redisManager.updateActiveAppForClient(deploymentKey, clientUniqueId, req.body.label, currentVersionLabel);
              }
            });
          } else if (!req.body.label && appVersion !== currentVersionLabel) {
            return redisManager.updateActiveAppForClient(deploymentKey, clientUniqueId, appVersion, appVersion);
          }
        })
        .catch((error: any) => {
          console.warn("Failed to record legacy deploy metric", error);
        })
        .done();
    }
  };

  const reportStatusDownload = function (req: express.Request, res: express.Response, next: (err?: any) => void) {
    const deploymentKey = req.body.deploymentKey || req.body.deployment_key;
    if (!req.body || !deploymentKey || !req.body.label) {
      return errorUtils.sendMalformedRequestError(
        res,
        "A download status report must contain a valid deploymentKey and package label."
      );
    }
    // Respond immediately to avoid blocking on Redis under burst traffic
    res.sendStatus(200);

    // Fire-and-forget metrics update; do not route errors to middleware to avoid
    // surfacing as request exceptions after the response has been sent.
    redisManager
      .incrementLabelStatusCount(deploymentKey, req.body.label, redis.DOWNLOADED)
      .catch((error: any) => {
        console.warn("Failed to record download metric", error);
      })
      .done();
  };

  router.get("/v0.1/public/codepush/update_check", updateCheck);

  router.post("/reportStatus/deploy", reportStatusDeploy);
  router.post("/v0.1/public/codepush/report_status/deploy", reportStatusDeploy);

  router.post("/reportStatus/download", reportStatusDownload);
  router.post("/v0.1/public/codepush/report_status/download", reportStatusDownload);

  return router;
}
