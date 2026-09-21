// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as express from "express";

const REQUEST_TIMEOUT_IN_MILLISECONDS: number = parseInt(process.env.REQUEST_TIMEOUT_IN_MILLISECONDS) || 120000;

// Release uploads push a bundle tens of megabytes wide and then hash it and write it to blob
// storage, so they need far more room than an acquisition request that should answer in
// milliseconds. Sharing one budget between the two means any value tight enough to shed a stalled
// update_check is also tight enough to kill a healthy release.
//
// The window is bounded on both sides. Post-upload processing has been measured at 63s at the
// worst across 81 releases, so anything near that kills healthy releases. App Service's front end
// abandons a request at roughly 230s and answers the caller with a 502, so exceeding that hands
// back the very error this timeout exists to replace. Staying under it keeps the failure ours to
// report.
const MANAGEMENT_REQUEST_TIMEOUT_IN_MILLISECONDS: number =
  parseInt(process.env.MANAGEMENT_REQUEST_TIMEOUT_IN_MILLISECONDS) || 180000;

export function RequestTimeoutHandler(
  timeoutInMilliseconds: number = REQUEST_TIMEOUT_IN_MILLISECONDS
): express.RequestHandler {
  return function (req: express.Request, res: express.Response, next: (err?: any) => void): any {
    // This is a socket inactivity timeout, and it is armed before the body has been read. A large
    // upload that stalls mid-flight therefore trips it while the client is still writing.
    req.setTimeout(timeoutInMilliseconds, (): void => {
      // Answering mid-upload leaves the exchange half-finished, and the Azure front end reports
      // that to the caller as a 502 rather than the 408 meant here. Closing the socket is both
      // honest and cheaper than a reply the client cannot correlate.
      if (res.headersSent || !req.complete) {
        req.destroy();
        return;
      }

      res.sendStatus(408);
    });

    next();
  };
}

export { MANAGEMENT_REQUEST_TIMEOUT_IN_MILLISECONDS };
