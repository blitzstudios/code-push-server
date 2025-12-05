// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  CachedRelease,
  PackageInfo,
  UpdateCheckCacheResponse,
  UpdateCheckRequest,
  UpdateCheckResponse,
} from "../../../shared/types/update-check";

export { PackageInfo, UpdateCheckResponse, CachedRelease, UpdateCheckCacheResponse, UpdateCheckRequest };

interface AccessKeyBase {
  createdBy?: string;
  /*legacy*/ description?: string;
  /*key*/ friendlyName?: string;
  /*generated key*/ name?: string;
}

/*out*/
export interface AccessKey extends AccessKeyBase {
  /*generated*/ createdTime?: number;
  expires: number;
  /*generated*/ isSession?: boolean;
}

/*in*/
export interface AccessKeyRequest extends AccessKeyBase {
  ttl?: number;
}

/*out*/
export interface DeploymentMetrics {
  [packageLabelOrAppVersion: string]: UpdateMetrics;
}

/*in*/
export interface DeploymentStatusReport {
  appVersion: string;
  clientUniqueId?: string;
  deploymentKey: string;
  previousDeploymentKey?: string;
  previousLabelOrAppVersion?: string;
  label?: string;
  status?: string;
}

/*in*/
export interface DownloadReport {
  clientUniqueId: string;
  deploymentKey: string;
  label: string;
}

/*out*/
export interface UpdateMetrics {
  active: number;
  downloaded?: number;
  failed?: number;
  installed?: number;
}

/*out*/
export interface Account {
  /*key*/ email: string;
  name: string;
  linkedProviders: string[];
}

/*out*/
export interface CollaboratorProperties {
  isCurrentAccount?: boolean;
  permission: string;
}

/*out*/
export interface CollaboratorMap {
  [email: string]: CollaboratorProperties;
}

/*inout*/
export interface App {
  /*generated*/ collaborators?: CollaboratorMap;
  /*key*/ name: string;
  /*generated*/ deployments?: string[];
}

/*in*/
export interface AppCreationRequest extends App {
  manuallyProvisionDeployments?: boolean;
}

/*inout*/
export interface Deployment {
  /*generated key*/ key?: string;
  /*key*/ name: string;
  /*generated*/ package?: Package;
}

/*out*/
export interface BlobInfo {
  size: number;
  url: string;
}

/*out*/
export interface PackageHashToBlobInfoMap {
  [packageHash: string]: BlobInfo;
}

/*inout*/
export interface Package extends PackageInfo {
  /*generated*/ blobUrl: string;
  /*generated*/ diffPackageMap?: PackageHashToBlobInfoMap;
  /*generated*/ originalLabel?: string; // Set on "Promote" and "Rollback"
  /*generated*/ originalDeployment?: string; // Set on "Promote"
  /*generated*/ releasedBy?: string; // Set by commitPackage
  /*generated*/ releaseMethod?: string; // "Upload", "Promote" or "Rollback". Unknown if unspecified
  /*generated*/ size: number;
  /*generated*/ uploadTime: number;
}

export * from "./rest-definitions";
