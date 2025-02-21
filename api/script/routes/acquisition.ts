// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as express from "express";
import * as semver from "semver";

import * as utils from "../utils/common";
import * as acquisitionUtils from "../utils/acquisition";
import * as errorUtils from "../utils/rest-error-handling";
import * as redis from "../redis-manager";
import * as restHeaders from "../utils/rest-headers";
import * as rolloutSelector from "../utils/rollout-selector";
import * as storageTypes from "../storage/storage";
import { UpdateCheckCacheResponse, UpdateCheckRequest, UpdateCheckResponse } from "../types/rest-definitions";
import * as validationUtils from "../utils/validation";

import * as q from "q";
import * as queryString from "querystring";
import * as URL from "url";
import Promise = q.Promise;

const METRICS_BREAKING_VERSION = "1.5.2-beta";

export interface AcquisitionConfig {
  storage: storageTypes.Storage;
  redisManager: redis.RedisManager;
}

function getUrlKey(originalUrl: string): string {
  const obj: any = URL.parse(originalUrl, /*parseQueryString*/ true);
  delete obj.query.clientUniqueId;
  return obj.pathname + "?" + queryString.stringify(obj.query);
}

function createResponseUsingStorage(
  req: express.Request,
  res: express.Response,
  storage: storageTypes.Storage
): Promise<redis.CacheableResponse> {
  const deploymentKey: string = String(req.query.deploymentKey || req.query.deployment_key);
  const appVersion: string = String(req.query.appVersion || req.query.app_version);
  const packageHash: string = String(req.query.packageHash || req.query.package_hash);
  const isCompanion: string = String(req.query.isCompanion || req.query.is_companion);

  console.log(`[Storage] Creating response - deploymentKey: ${deploymentKey}, appVersion: ${appVersion}, packageHash: ${packageHash}`);

  const updateRequest: UpdateCheckRequest = {
    deploymentKey: deploymentKey,
    appVersion: appVersion,
    packageHash: packageHash,
    isCompanion: isCompanion && isCompanion.toLowerCase() === "true",
    label: String(req.query.label),
  };

  let originalAppVersion: string;

  // Make an exception to allow plain integer numbers e.g. "1", "2" etc.
  const isPlainIntegerNumber: boolean = /^\d+$/.test(updateRequest.appVersion);
  if (isPlainIntegerNumber) {
    originalAppVersion = updateRequest.appVersion;
    updateRequest.appVersion = originalAppVersion + ".0.0";
    console.log(`[Storage] Converting plain integer version ${originalAppVersion} to semver: ${updateRequest.appVersion}`);
  }

  // Make an exception to allow missing patch versions e.g. "2.0" or "2.0-prerelease"
  const isMissingPatchVersion: boolean = /^\d+\.\d+([\+\-].*)?$/.test(updateRequest.appVersion);
  if (isMissingPatchVersion) {
    originalAppVersion = updateRequest.appVersion;
    const semverTagIndex = originalAppVersion.search(/[\+\-]/);
    if (semverTagIndex === -1) {
      updateRequest.appVersion += ".0";
    } else {
      updateRequest.appVersion = originalAppVersion.slice(0, semverTagIndex) + ".0" + originalAppVersion.slice(semverTagIndex);
    }
    console.log(`[Storage] Adding missing patch version. Original: ${originalAppVersion}, Modified: ${updateRequest.appVersion}`);
  }

  if (validationUtils.isValidUpdateCheckRequest(updateRequest)) {
    console.log(`[Storage] Valid update check request, fetching package history`);
    return storage.getPackageHistoryFromDeploymentKey(updateRequest.deploymentKey).then((packageHistory: storageTypes.Package[]) => {
      console.log(`[Storage] Retrieved ${packageHistory?.length || 0} packages from history`);
      const updateObject: UpdateCheckCacheResponse = acquisitionUtils.getUpdatePackageInfo(packageHistory, updateRequest);
      console.log(`[Storage] Generated update package info:`, JSON.stringify(updateObject, null, 2));
      
      if ((isMissingPatchVersion || isPlainIntegerNumber) && updateObject.originalPackage.appVersion === updateRequest.appVersion) {
        // Set the appVersion of the response to the original one with the missing patch version or plain number
        updateObject.originalPackage.appVersion = originalAppVersion;
        if (updateObject.rolloutPackage) {
          updateObject.rolloutPackage.appVersion = originalAppVersion;
        }
        console.log(`[Storage] Restored original version format: ${originalAppVersion}`);
      }

      const cacheableResponse: redis.CacheableResponse = {
        statusCode: 200,
        body: updateObject,
      };

      console.log(`[Storage] Created cacheable response with status ${cacheableResponse.statusCode}`);
      return q(cacheableResponse);
    });
  } else {
    console.log(`[Storage] Invalid update check request - deploymentKey valid: ${validationUtils.isValidKeyField(updateRequest.deploymentKey)}, appVersion valid: ${validationUtils.isValidAppVersionField(updateRequest.appVersion)}`);
    
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

  router.get("/health", (req: express.Request, res: express.Response, next: (err?: any) => void): any => {
    storage
      .checkHealth()
      .then(() => {
        return redisManager.checkHealth();
      })
      .then(() => {
        res.status(200).send("Healthy");
      })
      .catch((error: Error) => errorUtils.sendUnknownError(res, error, next))
      .done();
  });

  return router;
}

export function getAcquisitionRouter(config: AcquisitionConfig): express.Router {
  const storage: storageTypes.Storage = config.storage;
  const redisManager: redis.RedisManager = config.redisManager;
  const router: express.Router = express.Router();

  const updateCheck = function (newApi: boolean) {
    return function (req: express.Request, res: express.Response, next: (err?: any) => void) {
      const deploymentKey: string = String(req.query.deploymentKey || req.query.deployment_key);
      const key: string = redis.Utilities.getDeploymentKeyHash(deploymentKey);
      const clientUniqueId: string = String(req.query.clientUniqueId || req.query.client_unique_id);
      const url: string = getUrlKey(req.originalUrl);
      let fromCache: boolean = true;
      let redisError: Error;

      console.log(`[UpdateCheck] Starting update check for deploymentKey: ${deploymentKey}, clientId: ${clientUniqueId}`);
      console.log(`[UpdateCheck] Redis key: ${key}, url: ${url}`);

      redisManager
        .getCachedResponse(key, url)
        .catch((error: Error) => {
          console.error(`[UpdateCheck] Redis cache error for key ${key}:`, error);
          // Store the redis error to be thrown after we send response.
          redisError = error;
          return q<redis.CacheableResponse>(null);
        })
        .then((cachedResponse: redis.CacheableResponse) => {
          fromCache = !!cachedResponse;
          console.log(`[UpdateCheck] Cache hit: ${fromCache} for key: ${key}`);
          return cachedResponse || createResponseUsingStorage(req, res, storage);
        })
        .then((response: redis.CacheableResponse) => {
          if (!response) {
            console.log(`[UpdateCheck] No response generated for key: ${key}`);
            return q<void>(null);
          }

          let giveRolloutPackage: boolean = false;
          const cachedResponseObject = <UpdateCheckCacheResponse>response.body;
          if (cachedResponseObject.rolloutPackage && clientUniqueId) {
            const releaseSpecificString: string =
              cachedResponseObject.rolloutPackage.label || cachedResponseObject.rolloutPackage.packageHash;
            giveRolloutPackage = rolloutSelector.isSelectedForRollout(
              clientUniqueId,
              cachedResponseObject.rollout,
              releaseSpecificString
            );
            console.log(`[UpdateCheck] Rollout decision for clientId ${clientUniqueId}: ${giveRolloutPackage}`);
          }

          const updateCheckBody: { updateInfo: UpdateCheckResponse } = {
            updateInfo: giveRolloutPackage ? cachedResponseObject.rolloutPackage : cachedResponseObject.originalPackage,
          };

          // Change in new API
          updateCheckBody.updateInfo.target_binary_range = updateCheckBody.updateInfo.appVersion;

          res.locals.fromCache = fromCache;
          res.status(response.statusCode).send(newApi ? utils.convertObjectToSnakeCase(updateCheckBody) : updateCheckBody);

          // Update REDIS cache after sending the response so that we don't block the request.
          if (!fromCache) {
            console.log(`[UpdateCheck] Setting cached response for key: ${key}`);
            return redisManager.setCachedResponse(key, url, response).then(() => {
              console.log(`[UpdateCheck] Successfully cached response for key: ${key}`);
            }).catch(err => {
              console.error(`[UpdateCheck] Failed to cache response for key: ${key}:`, err);
              throw err;
            });
          }
        })
        .then(() => {
          if (redisError) {
            throw redisError;
          }
        })
        .catch((error: storageTypes.StorageError) => errorUtils.restErrorHandler(res, error, next))
        .done();
    };
  };

  const reportStatusDeploy = function (req: express.Request, res: express.Response, next: (err?: any) => void) {
    const deploymentKey = req.body.deploymentKey || req.body.deployment_key;
    const appVersion = req.body.appVersion || req.body.app_version;
    const previousDeploymentKey = req.body.previousDeploymentKey || req.body.previous_deployment_key || deploymentKey;
    const previousLabelOrAppVersion = req.body.previousLabelOrAppVersion || req.body.previous_label_or_app_version;
    const clientUniqueId = req.body.clientUniqueId || req.body.client_unique_id;

    console.log(`[ReportDeploy] Received status report - deploymentKey: ${deploymentKey}, appVersion: ${appVersion}`);
    console.log(`[ReportDeploy] Previous state - deploymentKey: ${previousDeploymentKey}, labelOrVersion: ${previousLabelOrAppVersion}`);
    console.log(`[ReportDeploy] Client ID: ${clientUniqueId}, Label: ${req.body.label}, Status: ${req.body.status}`);

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
    console.log(`[ReportDeploy] SDK Version check - Received version: ${sdkVersion}, Breaking version: ${METRICS_BREAKING_VERSION}`);
    console.log(`[ReportDeploy] Semver validation - Is valid: ${semver.valid(sdkVersion)}, Meets minimum version: ${semver.valid(sdkVersion) ? semver.gte(sdkVersion, METRICS_BREAKING_VERSION) : 'N/A'}`);

    if (semver.valid(sdkVersion) && semver.gte(sdkVersion, METRICS_BREAKING_VERSION)) {
      console.log(`[ReportDeploy] Using new metrics format (SDK version: ${sdkVersion})`);
      // If previousDeploymentKey not provided, assume it is the same deployment key.
      let redisUpdatePromise: q.Promise<void>;

      if (req.body.label && req.body.status === redis.DEPLOYMENT_FAILED) {
        console.log(`[ReportDeploy] Recording deployment failure for label: ${req.body.label}`);
        redisUpdatePromise = redisManager.incrementLabelStatusCount(deploymentKey, req.body.label, req.body.status);
      } else {
        const labelOrAppVersion: string = req.body.label || appVersion;
        console.log(`[ReportDeploy] Recording successful update to: ${labelOrAppVersion}`);
        redisUpdatePromise = redisManager.recordUpdate(
          deploymentKey,
          labelOrAppVersion,
          previousDeploymentKey,
          previousLabelOrAppVersion
        );
      }

      redisUpdatePromise
        .then(() => {
          console.log(`[ReportDeploy] Successfully recorded metrics for deploymentKey: ${deploymentKey}`);
          res.sendStatus(200);
          if (clientUniqueId) {
            console.log(`[ReportDeploy] Cleaning up client active label - clientId: ${clientUniqueId}`);
            redisManager.removeDeploymentKeyClientActiveLabel(previousDeploymentKey, clientUniqueId);
          }
        })
        .catch((error: any) => {
          console.error(`[ReportDeploy] Failed to record metrics:`, error);
          errorUtils.sendUnknownError(res, error, next);
        })
        .done();
    } else {
      console.log(`[ReportDeploy] Using legacy metrics format - Invalid or outdated SDK version: ${sdkVersion}`);
      
      if (!clientUniqueId) {
        console.log(`[ReportDeploy] Legacy format requires clientUniqueId but none provided`);
        return errorUtils.sendMalformedRequestError(
          res,
          "A deploy status report must contain a valid appVersion, clientUniqueId and deploymentKey."
        );
      }

      return redisManager
        .getCurrentActiveLabel(deploymentKey, clientUniqueId)
        .then((currentVersionLabel: string) => {
          console.log(`[ReportDeploy] Legacy - Current active label for client ${clientUniqueId}: ${currentVersionLabel}`);
          
          if (req.body.label && req.body.label !== currentVersionLabel) {
            console.log(`[ReportDeploy] Legacy - Updating metrics for new label: ${req.body.label}`);
            return redisManager.incrementLabelStatusCount(deploymentKey, req.body.label, req.body.status).then(() => {
              if (req.body.status === redis.DEPLOYMENT_SUCCEEDED) {
                console.log(`[ReportDeploy] Legacy - Updating active app for successful deployment`);
                return redisManager.updateActiveAppForClient(deploymentKey, clientUniqueId, req.body.label, currentVersionLabel);
              }
            });
          } else if (!req.body.label && appVersion !== currentVersionLabel) {
            console.log(`[ReportDeploy] Legacy - Updating active app version to: ${appVersion}`);
            return redisManager.updateActiveAppForClient(deploymentKey, clientUniqueId, appVersion, appVersion);
          } else {
            console.log(`[ReportDeploy] Legacy - No update needed, versions match`);
          }
        })
        .then(() => {
          console.log(`[ReportDeploy] Legacy - Successfully completed status update`);
          res.sendStatus(200);
        })
        .catch((error: any) => {
          console.error(`[ReportDeploy] Legacy - Failed to update status:`, error);
          errorUtils.sendUnknownError(res, error, next);
        })
        .done();
    }
  };

  const reportStatusDownload = function (req: express.Request, res: express.Response, next: (err?: any) => void) {
    const deploymentKey = req.body.deploymentKey || req.body.deployment_key;
    console.log(`[ReportDownload] Recording download for deploymentKey: ${deploymentKey}, label: ${req.body.label}`);
    
    if (!req.body || !deploymentKey || !req.body.label) {
      return errorUtils.sendMalformedRequestError(
        res,
        "A download status report must contain a valid deploymentKey and package label."
      );
    }
    return redisManager
      .incrementLabelStatusCount(deploymentKey, req.body.label, redis.DOWNLOADED)
      .then(() => {
        console.log(`[ReportDownload] Successfully recorded download for label: ${req.body.label}`);
        res.sendStatus(200);
      })
      .catch((error: any) => {
        console.error(`[ReportDownload] Failed to record download:`, error);
        errorUtils.sendUnknownError(res, error, next);
      })
      .done();
  };

  router.get("/updateCheck", updateCheck(false));
  router.get("/v0.1/public/codepush/update_check", updateCheck(true));

  router.post("/reportStatus/deploy", reportStatusDeploy);
  router.post("/v0.1/public/codepush/report_status/deploy", reportStatusDeploy);

  router.post("/reportStatus/download", reportStatusDownload);
  router.post("/v0.1/public/codepush/report_status/download", reportStatusDownload);

  return router;
}
