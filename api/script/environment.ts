// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as os from 'os';

export function getTempDirectory(): string {
  return process.env.TEMP || process.env.TMPDIR || os.tmpdir();
}
