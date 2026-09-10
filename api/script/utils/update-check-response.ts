import * as express from "express";
import * as q from "q";
import Promise = q.Promise;
import * as utils from "./common";
import { CacheableResponse } from "../redis-manager";
import { DiffMapFetcher, buildUpdateCheckBody } from "./acquisition";

// How long a shared cache (CDN edge) may hold an update check answer. Matches the
// in-process microcache window, so the edge never serves anything staler than an
// instance already would. Set to 0 to keep update checks off the edge entirely.
const UPDATECHECK_EDGE_TTL_SECONDS: number = Number(process.env.UPDATECHECK_EDGE_TTL_SECONDS) || 30;

export interface SendUpdateCheckOptions {
  res: express.Response;
  fromCache: boolean;
  clientUniqueId: string;
  betaRequested: boolean;
  requestLabel: string;
  requestPackageHash: string;
  rawAppVersion: string;
  normalizedAppVersion: string;
  isCompanion: boolean;
  diffMapFetcher: DiffMapFetcher;
  /** Set false for answers that don't reflect real deployment state. Defaults to true. */
  shareable?: boolean;
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
  ).then(({ updateInfo, varyByClient }) => {
    options.res.locals.fromCache = options.fromCache;

    // A shared cache may only hold answers that are fully determined by the
    // request parameters. A ramping rollout buckets on the device id, so those
    // answers belong to one client only. This overrides the blanket no-cache set
    // by the headers middleware.
    // s-maxage rather than max-age: this is aimed at the CDN, and devices should keep
    // revalidating exactly as they do today. Holding a copy on the device would delay a
    // release by the TTL a second time, on top of the edge's own window.
    const isShareable = options.shareable !== false && !varyByClient && UPDATECHECK_EDGE_TTL_SECONDS > 0;
    options.res.setHeader(
      "Cache-Control",
      isShareable ? `public, s-maxage=${UPDATECHECK_EDGE_TTL_SECONDS}, max-age=0` : "no-store"
    );

    options.res.status(response.statusCode).send(utils.convertObjectToSnakeCase({ updateInfo }));
  });
}
