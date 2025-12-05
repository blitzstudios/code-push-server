import * as express from "express";
import * as q from "q";
import * as utils from "./common";
import { CacheableResponse } from "../redis-manager";
import { DiffMapFetcher, buildUpdateCheckBody } from "./acquisition";

export interface SendUpdateCheckOptions {
  res: express.Response;
  newApi: boolean;
  fromCache: boolean;
  clientUniqueId: string;
  betaRequested: boolean;
  requestLabel: string;
  requestPackageHash: string;
  rawAppVersion: string;
  normalizedAppVersion: string;
  isCompanion: boolean;
  diffMapFetcher: DiffMapFetcher;
}

export function sendUpdateCheckResponse(
  response: CacheableResponse,
  options: SendUpdateCheckOptions
): Promise<void> {
  return q(
    buildUpdateCheckBody(
      response,
      options.clientUniqueId,
      options.betaRequested,
      options.requestLabel,
      options.requestPackageHash,
      options.rawAppVersion,
      options.normalizedAppVersion,
      options.isCompanion,
      options.diffMapFetcher
    )
  ).then((updateCheckBody) => {
    options.res.locals.fromCache = options.fromCache;
    const payload = options.newApi ? utils.convertObjectToSnakeCase(updateCheckBody) : updateCheckBody;
    options.res.status(response.statusCode).send(payload);
  });
}

