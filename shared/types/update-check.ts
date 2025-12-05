export interface PackageInfo {
  appVersion?: string;
  description?: string;
  isDisabled?: boolean;
  isMandatory?: boolean;
  /*generated*/ label?: string;
  /*generated*/ packageHash?: string;
  rollout?: number;
  holdDurationMinutes?: number;
  rampDurationMinutes?: number;
}

export interface UpdateCheckResponse extends PackageInfo {
  target_binary_range?: string;
  downloadURL?: string;
  isAvailable: boolean;
  packageSize?: number;
  updateAppVersion?: boolean;
}

export interface CachedRelease {
  appVersion: string;
  blobUrl: string;
  description?: string;
  isDisabled?: boolean;
  isMandatory?: boolean;
  label?: string;
  packageHash: string;
  size: number;
  rollout?: number;
  rolloutHoldDurationMinutes?: number;
  rolloutRampDurationMinutes?: number;
  rolloutUploadTime?: number;
}

export interface UpdateCheckCacheResponse {
  releases: CachedRelease[];
}

export interface UpdateCheckRequest {
  appVersion: string;
  clientUniqueId?: string;
  deploymentKey: string;
  isCompanion?: boolean;
  beta?: boolean;
  label?: string;
  packageHash?: string;
}

