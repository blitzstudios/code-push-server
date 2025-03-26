// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as diffErrorUtils from "./diff-error-handling";
import * as env from "../environment";
import * as fs from "fs";
import * as hashUtils from "../utils/hash-utils";
import * as path from "path";
import * as q from "q";
import * as security from "../utils/security";
import * as semver from "semver";
import * as storageTypes from "../storage/storage";
import * as stream from "stream";
import * as streamifier from "streamifier";
import * as superagent from "superagent";
import * as yazl from "yazl";
import * as yauzl from "yauzl";
import PackageManifest = hashUtils.PackageManifest;
import Promise = q.Promise;
import request = require("superagent");

interface IArchiveDiff {
  deletedFiles: string[];
  newOrUpdatedEntries: Map<string, string>; // K = name, V = hash
}

interface DiffBlobInfo {
  packageHash: string;
  blobInfo: storageTypes.BlobInfo;
}

export class PackageDiffer {
  private static MANIFEST_FILE_NAME: string = "hotcodepush.json";
  private static WORK_DIRECTORY_PATH: string = env.getTempDirectory();

  private _storage: storageTypes.Storage;
  private _maxPackagesToDiff: number;

  constructor(storage: storageTypes.Storage, maxPackagesToDiff?: number) {
    this._maxPackagesToDiff = maxPackagesToDiff || 1;
    this._storage = storage;
  }

  public generateDiffPackageMap(
    accountId: string,
    appId: string,
    deploymentId: string,
    newPackage: storageTypes.Package
  ): Promise<storageTypes.PackageHashToBlobInfoMap> {
    if (!newPackage || !newPackage.blobUrl || !newPackage.manifestBlobUrl) {
      console.log(`[generateDiffPackageMap] Missing required package info. blobUrl: ${!!newPackage?.blobUrl}, manifestBlobUrl: ${!!newPackage?.manifestBlobUrl}`);
      return q.reject<storageTypes.PackageHashToBlobInfoMap>(
        diffErrorUtils.diffError(diffErrorUtils.ErrorCode.InvalidArguments, "Package information missing")
      );
    }

    console.log(`[generateDiffPackageMap] Starting for package ${newPackage.label}, hash: ${newPackage.packageHash}`);
    console.log(`[generateDiffPackageMap] Manifest URL: ${newPackage.manifestBlobUrl}`);
    
    const manifestPromise: Promise<PackageManifest> = this.getManifest(newPackage);
    const historyPromise: Promise<storageTypes.Package[]> = this._storage.getPackageHistory(accountId, appId, deploymentId);
    const newReleaseFilePromise: Promise<string> = this.downloadArchiveFromUrl(newPackage.blobUrl);
    let newFilePath: string;

    console.log(`[generateDiffPackageMap] Promises created for manifest, history, and download`);

    return q
      .all<any>([manifestPromise, historyPromise, newReleaseFilePromise])
      .spread((newManifest: PackageManifest, history: storageTypes.Package[], downloadedArchiveFile: string) => {
        newFilePath = downloadedArchiveFile;
        
        console.log(`[generateDiffPackageMap] Got manifest: ${newManifest ? 'yes' : 'no'}, history: ${history?.length || 0} packages, downloaded file: ${!!downloadedArchiveFile}`);
        
        if (!newManifest) {
          console.log(`[generateDiffPackageMap] No manifest available, cannot generate diffs`);
          return [];
        }
        
        const fileMap = newManifest.toMap();
        const fileCount = Object.keys(fileMap || {}).length;
        console.log(`[generateDiffPackageMap] Manifest contains ${fileCount} files`);
        
        const packagesToDiff: storageTypes.Package[] = this.getPackagesToDiff(
          history,
          newPackage.appVersion,
          newPackage.packageHash,
          newPackage.label
        );
        
        console.log(`[generateDiffPackageMap] Found ${packagesToDiff?.length || 0} packages to diff against`);
        
        const diffBlobInfoPromises: Promise<DiffBlobInfo>[] = [];
        if (packagesToDiff) {
          packagesToDiff.forEach((appPackage: storageTypes.Package) => {
            console.log(`[generateDiffPackageMap] Adding diff task for package ${appPackage.label}, hash: ${appPackage.packageHash}`);
            diffBlobInfoPromises.push(
              this.uploadAndGetDiffBlobInfo(accountId, appPackage, newPackage.packageHash, newManifest, newFilePath)
            );
          });
        }

        return q.all(diffBlobInfoPromises);
      })
      .then((diffBlobInfoList: DiffBlobInfo[]) => {
        // all done, delete the downloaded archive file.
        fs.unlinkSync(newFilePath);

        console.log(`[generateDiffPackageMap] Processed ${diffBlobInfoList?.length || 0} diffs`);
        
        if (diffBlobInfoList && diffBlobInfoList.length) {
          let diffPackageMap: storageTypes.PackageHashToBlobInfoMap = null;
          diffBlobInfoList.forEach((diffBlobInfo: DiffBlobInfo) => {
            if (diffBlobInfo && diffBlobInfo.blobInfo) {
              diffPackageMap = diffPackageMap || {};
              diffPackageMap[diffBlobInfo.packageHash] = diffBlobInfo.blobInfo;
              console.log(`[generateDiffPackageMap] Added diff for package hash ${diffBlobInfo.packageHash}, size: ${diffBlobInfo.blobInfo.size} bytes`);
            }
          });

          console.log(`[generateDiffPackageMap] Returning diff package map with ${Object.keys(diffPackageMap || {}).length} entries`);
          return diffPackageMap;
        } else {
          console.log(`[generateDiffPackageMap] No diff packages were generated`);
          return q<storageTypes.PackageHashToBlobInfoMap>(null);
        }
      })
      .catch((error) => {
        console.error(`[generateDiffPackageMap] Error: ${error.message || error}`);
        return diffErrorUtils.diffErrorHandler(error);
      });
  }

  public generateDiffArchive(oldManifest: PackageManifest, newManifest: PackageManifest, newArchiveFilePath: string): Promise<string> {
    return Promise<string>(
      (resolve: (value?: string | Promise<string>) => void, reject: (reason: any) => void, notify: (progress: any) => void): void => {
        console.log(`[generateDiffArchive] Starting generation`);
        
        if (!oldManifest || !newManifest) {
          console.log(`[generateDiffArchive] Missing manifests - oldManifest: ${!!oldManifest}, newManifest: ${!!newManifest}`);
          resolve(null);
          return;
        }

        const diff: IArchiveDiff = PackageDiffer.generateDiff(oldManifest.toMap(), newManifest.toMap());
        console.log(`[generateDiffArchive] Generated diff - deletedFiles: ${diff.deletedFiles.length}, newOrUpdatedFiles: ${diff.newOrUpdatedEntries.size}`);

        if (diff.deletedFiles.length === 0 && diff.newOrUpdatedEntries.size === 0) {
          console.log(`[generateDiffArchive] No differences found, skipping archive creation`);
          resolve(null);
          return;
        }

        PackageDiffer.ensureWorkDirectoryExists();
        console.log(`[generateDiffArchive] Work directory exists`);

        const diffFilePath = path.join(PackageDiffer.WORK_DIRECTORY_PATH, "diff_" + PackageDiffer.randomString(20) + ".zip");
        console.log(`[generateDiffArchive] Will create diff archive at: ${diffFilePath}`);
        
        const writeStream: stream.Writable = fs.createWriteStream(diffFilePath);
        const diffFile = new yazl.ZipFile();

        diffFile.outputStream.pipe(writeStream).on("close", (): void => {
          console.log(`[generateDiffArchive] Successfully created diff archive: ${diffFilePath}`);
          resolve(diffFilePath);
        });

        const json: string = JSON.stringify({ deletedFiles: diff.deletedFiles });
        console.log(`[generateDiffArchive] Added manifest with ${diff.deletedFiles.length} deleted files`);
        const readStream: stream.Readable = streamifier.createReadStream(json);
        diffFile.addReadStream(readStream, PackageDiffer.MANIFEST_FILE_NAME);

        // Iterate through the diff entries to avoid memory overrun when dealing
        // with large files
        console.log(`[generateDiffArchive] Opening source archive: ${newArchiveFilePath}`);
        yauzl.open(newArchiveFilePath, { lazyEntries: true }, (err?: Error, zipFile?: any): void => {
          if (err) {
            console.error(`[generateDiffArchive] Error opening source archive: ${err.message}`);
            reject(err);
            return;
          }

          zipFile.readEntry();
          zipFile
            .on("entry", (entry: any): void => {
              // Skip processing non-file entries.
              if (entry.fileName.endsWith("/")) {
                zipFile.readEntry();
                return;
              }

              const fileName: string = PackageManifest.normalizePath(entry.fileName);
              // Skip processing files that don't match certain conditions.
              if (PackageManifest.isIgnored(fileName)) {
                zipFile.readEntry();
                return;
              }

              // Add an updated file to the diff zip file if it's new or changed
              for (const [fileNameHash, fileHash] of diff.newOrUpdatedEntries) {
                if (fileNameHash === fileName) {
                  zipFile.openReadStream(entry, (entryErr?: Error, readStream?: stream.Readable): void => {
                    if (entryErr) {
                      console.error(`[generateDiffArchive] Error opening read stream for entry ${fileName}: ${entryErr.message}`);
                      reject(entryErr);
                      return;
                    }

                    console.log(`[generateDiffArchive] Adding updated/new file to diff: ${fileName}`);
                    diffFile.addReadStream(readStream, fileName);
                    diff.newOrUpdatedEntries.delete(fileNameHash);
                    zipFile.readEntry();
                  });
                  return;
                }
              }

              zipFile.readEntry();
            })
            .on("end", (): void => {
              if (diff.newOrUpdatedEntries.size > 0) {
                console.warn(`[generateDiffArchive] Warning: ${diff.newOrUpdatedEntries.size} files in diff were not found in the archive`);
                for (const [fileName, _] of diff.newOrUpdatedEntries) {
                  console.warn(`[generateDiffArchive] - Missing file: ${fileName}`);
                }
              }
              
              console.log(`[generateDiffArchive] Finalizing diff archive`);
              diffFile.end();
            })
            .on("error", (zipErr?: Error): void => {
              console.error(`[generateDiffArchive] Error processing zip: ${zipErr.message}`);
              reject(zipErr);
            });
        });
      }
    );
  }

  private uploadDiffArchiveBlob(blobId: string, diffArchiveFilePath: string): Promise<storageTypes.BlobInfo> {
    return Promise<storageTypes.BlobInfo>(
      (
        resolve: (value?: storageTypes.BlobInfo | Promise<storageTypes.BlobInfo>) => void,
        reject: (reason: any) => void,
        notify: (progress: any) => void
      ): void => {
        fs.stat(diffArchiveFilePath, (err: NodeJS.ErrnoException, stats: fs.Stats): void => {
          if (err) {
            reject(err);
            return;
          }

          const readable: fs.ReadStream = fs.createReadStream(diffArchiveFilePath);

          this._storage
            .addBlob(blobId, readable, stats.size)
            .then((blobId: string): Promise<string> => {
              return this._storage.getBlobUrl(blobId);
            })
            .then((blobUrl: string): void => {
              fs.unlink(diffArchiveFilePath, (error) => {
                if (error) {
                  console.error("Error occurred while unlinking file:", error);
                }
              });

              const diffBlobInfo: storageTypes.BlobInfo = { size: stats.size, url: blobUrl };

              resolve(diffBlobInfo);
            })
            .catch((): void => {
              resolve(null);
            })
            .done();
        });
      }
    );
  }

  private uploadAndGetDiffBlobInfo(
    accountId: string,
    appPackage: storageTypes.Package,
    newPackageHash: string,
    newManifest: PackageManifest,
    newFilePath: string
  ): Promise<DiffBlobInfo> {
    console.log(`[uploadAndGetDiffBlobInfo] Starting for package ${appPackage.label}, hash: ${appPackage.packageHash}`);
    
    if (!appPackage || appPackage.packageHash === newPackageHash) {
      // If the packageHash matches, no need to calculate diff, its the same package.
      console.log(`[uploadAndGetDiffBlobInfo] Skipping - ${!appPackage ? 'no package' : 'same hash'}`);
      return q<DiffBlobInfo>(null);
    }

    console.log(`[uploadAndGetDiffBlobInfo] Getting manifest for package ${appPackage.label}`);
    return this.getManifest(appPackage)
      .then((existingManifest?: PackageManifest) => {
        console.log(`[uploadAndGetDiffBlobInfo] Got manifest for old package: ${existingManifest ? 'yes' : 'no'}`);
        if (existingManifest) {
          const fileCount = Object.keys(existingManifest.toMap() || {}).length;
          console.log(`[uploadAndGetDiffBlobInfo] Old manifest contains ${fileCount} files`);
        }
        
        console.log(`[uploadAndGetDiffBlobInfo] Generating diff archive`);
        return this.generateDiffArchive(existingManifest, newManifest, newFilePath);
      })
      .then((diffArchiveFilePath?: string): Promise<storageTypes.BlobInfo> => {
        console.log(`[uploadAndGetDiffBlobInfo] Diff archive generated: ${diffArchiveFilePath ? 'yes' : 'no'}`);
        
        if (diffArchiveFilePath) {
          console.log(`[uploadAndGetDiffBlobInfo] Uploading diff archive blob`);
          return this.uploadDiffArchiveBlob(security.generateSecureKey(accountId), diffArchiveFilePath);
        }

        console.log(`[uploadAndGetDiffBlobInfo] No diff archive to upload`);
        return q(<storageTypes.BlobInfo>null);
      })
      .then((blobInfo: storageTypes.BlobInfo) => {
        if (blobInfo) {
          console.log(`[uploadAndGetDiffBlobInfo] Uploaded blob, size: ${blobInfo.size} bytes`);
          return { packageHash: appPackage.packageHash, blobInfo: blobInfo };
        } else {
          console.log(`[uploadAndGetDiffBlobInfo] No blob info available`);
          return q<DiffBlobInfo>(null);
        }
      })
      .catch((error) => {
        console.error(`[uploadAndGetDiffBlobInfo] Error: ${error.message || error}`);
        return null;
      });
  }

  private getManifest(appPackage: storageTypes.Package): Promise<PackageManifest> {
    return Promise<PackageManifest>(
      (resolve: (manifest: PackageManifest) => void, reject: (error: any) => void, notify: (progress: any) => void): void => {
        console.log(`[getManifest] Starting for package ${appPackage?.label || 'unknown'}`);
        
        if (!appPackage || !appPackage.manifestBlobUrl) {
          console.log(`[getManifest] No package or manifest URL, returning null`);
          resolve(null);
          return;
        }

        console.log(`[getManifest] Downloading manifest from URL: ${appPackage.manifestBlobUrl}`);
        
        const req: superagent.Request<any> = superagent
          .get(appPackage.manifestBlobUrl)
          .buffer(true)
          .parse(superagent.parse.text);

        req.end((err, res) => {
          if (err) {
            console.error(`[getManifest] Error downloading manifest: ${err.message}`);
            resolve(null);
            return;
          }

          if (!res.text) {
            console.error(`[getManifest] Manifest download succeeded but no text content received`);
            console.log(`[getManifest] Response status: ${res.status}, type: ${res.type}, headers:`, res.headers);
            resolve(null);
            return;
          }

          try {
            console.log(`[getManifest] Downloaded manifest (${res.text.length} bytes), content-type: ${res.type}`);
            console.log(`[getManifest] Manifest first 200 chars: ${res.text.substring(0, 200)}...`);
            
            const manifest = PackageManifest.deserialize(res.text);
            if (manifest) {
              const fileMap = manifest.toMap();
              const fileCount = Object.keys(fileMap || {}).length;
              console.log(`[getManifest] Successfully parsed manifest with ${fileCount} files`);
              if (fileCount > 0) {
                const sampleFiles = Object.keys(fileMap).slice(0, 3);
                console.log(`[getManifest] Sample files: ${sampleFiles.join(', ')}${fileCount > 3 ? '...' : ''}`);
              } else {
                console.warn(`[getManifest] Warning: Manifest contains zero files`);
              }
            } else {
              console.error(`[getManifest] Manifest deserialization returned null`);
            }
            
            resolve(manifest);
          } catch (e) {
            console.error(`[getManifest] Error parsing manifest: ${e.message}`);
            console.log(`[getManifest] Raw content that failed parsing: ${res.text.substring(0, 500)}...`);
            resolve(null);
          }
        });
      }
    );
  }

  private downloadArchiveFromUrl(url: string): Promise<string> {
    return Promise<string>(
      (resolve: (value?: string | Promise<string>) => void, reject: (reason: any) => void, notify: (progress: any) => void): void => {
        PackageDiffer.ensureWorkDirectoryExists();

        const downloadedArchiveFilePath = path.join(
          PackageDiffer.WORK_DIRECTORY_PATH,
          "temp_" + PackageDiffer.randomString(20) + ".zip"
        );
        const writeStream: stream.Writable = fs.createWriteStream(downloadedArchiveFilePath);
        const req: request.Request<any> = request.get(url);

        req.pipe(writeStream).on("finish", () => {
          resolve(downloadedArchiveFilePath);
        });
      }
    );
  }

  private getPackagesToDiff(
    history: storageTypes.Package[],
    appVersion: string,
    newPackageHash: string,
    newPackageLabel: string
  ): storageTypes.Package[] {
    console.log(`[getPackagesToDiff] Starting with ${history?.length || 0} packages in history`);
    console.log(`[getPackagesToDiff] App version: ${appVersion}, new hash: ${newPackageHash}, new label: ${newPackageLabel}`);
    
    if (!history || !history.length) {
      console.log(`[getPackagesToDiff] No history available`);
      return null;
    }

    // Only diff with packages of the same app version.
    // Ignore already processed diffs.
    const matchingAppVersionPackages: storageTypes.Package[] = history.filter((item: storageTypes.Package) => {
      const matchingVersion = PackageDiffer.isMatchingAppVersion(item.appVersion, appVersion);
      const alreadyHasDiff = item.diffPackageMap && item.diffPackageMap[newPackageHash];
      
      if (!matchingVersion) {
        console.log(`[getPackagesToDiff] Skipping package ${item.label} - app version mismatch: ${item.appVersion} vs ${appVersion}`);
      }
      if (alreadyHasDiff) {
        console.log(`[getPackagesToDiff] Skipping package ${item.label} - already has diff for hash ${newPackageHash}`);
      }
      
      return matchingVersion && !alreadyHasDiff;
    });

    console.log(`[getPackagesToDiff] Found ${matchingAppVersionPackages.length} packages with matching app version`);

    if (matchingAppVersionPackages.length) {
      // Sort packages by uploadTime in descending order to get newest packages first
      const sortedPackages = matchingAppVersionPackages.sort((a, b) => {
        return b.uploadTime - a.uploadTime;
      });
      
      const maxPackagesToDiff = Math.min(this._maxPackagesToDiff, sortedPackages.length);
      const packagesToProcess = sortedPackages.slice(0, maxPackagesToDiff);
      
      console.log(`[getPackagesToDiff] Will diff against ${packagesToProcess.length} packages (max limit: ${this._maxPackagesToDiff})`);
      packagesToProcess.forEach(pkg => {
        console.log(`[getPackagesToDiff] - Package to diff: ${pkg.label}, hash: ${pkg.packageHash}`);
      });
      
      return packagesToProcess;
    }

    console.log(`[getPackagesToDiff] No suitable packages found for diffing`);
    return null;
  }

  private static generateDiff(oldFileHashes: Map<string, string>, newFileHashes: Map<string, string>): IArchiveDiff {
    const diff: IArchiveDiff = { deletedFiles: [], newOrUpdatedEntries: new Map<string, string>() };

    newFileHashes.forEach((hash: string, name: string): void => {
      if (!PackageDiffer.isEntryInMap(name, hash, oldFileHashes, /*requireContentMatch*/ true)) {
        diff.newOrUpdatedEntries.set(name, hash);
      }
    });

    oldFileHashes.forEach((hash: string, name: string): void => {
      if (!PackageDiffer.isEntryInMap(name, hash, newFileHashes, /*requireContentMatch*/ false)) {
        diff.deletedFiles.push(name);
      }
    });

    return diff;
  }

  private static isMatchingAppVersion(baseAppVersion: string, newAppVersion: string): boolean {
    let isMatchingAppVersion: boolean = false;
    if (!semver.valid(baseAppVersion)) {
      // baseAppVersion is a semver range
      if (!semver.valid(newAppVersion)) {
        // newAppVersion is a semver range
        isMatchingAppVersion = semver.validRange(newAppVersion) === semver.validRange(baseAppVersion);
      } else {
        // newAppVersion is not a semver range
        isMatchingAppVersion = semver.satisfies(newAppVersion, baseAppVersion);
      }
    } else {
      // baseAppVersion is not a semver range
      isMatchingAppVersion = semver.satisfies(baseAppVersion, newAppVersion);
    }

    return isMatchingAppVersion;
  }

  private static ensureWorkDirectoryExists(): void {
    if (!fs.existsSync(PackageDiffer.WORK_DIRECTORY_PATH)) {
      fs.mkdirSync(PackageDiffer.WORK_DIRECTORY_PATH);
    }
  }

  private static isEntryInMap(name: string, hash: string, map: Map<string, string>, requireContentMatch?: boolean): boolean {
    const hashInMap: string = map.get(name);
    return requireContentMatch ? hashInMap === hash : !!hashInMap;
  }

  private static randomString(length: number): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let str = "";
    for (let i = 0; i < length; i++) {
      str += chars[Math.floor(Math.random() * chars.length)];
    }

    return str;
  }
}
