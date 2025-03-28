// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as os from 'os';

export function getTempDirectory(): string {
  return process.env.TEMP || process.env.TMPDIR || os.tmpdir();
}

export function getUpdateCheckProxyUrl(): string {
  return process.env.UPDATE_CHECK_PROXY_URL;
}
