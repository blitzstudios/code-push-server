// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as crypto from "crypto";
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

interface PackageWithManifest {
  appPackage: storageTypes.Package;
  manifest: PackageManifest;
}

interface ArchiveGroup {
  diff: IArchiveDiff;
  packageHashes: string[]; // every historical package whose diff resolves to this one archive
}

interface ExtractedEntry {
  fileName: string; // the name as stored in the archive, which is what a diff refers to
  isDirectory: boolean;
  filePath: string; // where the entry was written, unset for directories
}

interface ExtractedArchive {
  directoryPath: string;
  entries: ExtractedEntry[]; // in archive order, so diffs keep the entry ordering they had before
}

export class PackageDiffer {
  private static MANIFEST_FILE_NAME: string = "hotcodepush.json";
  private static WORK_DIRECTORY_PATH: string = env.getTempDirectory();
  private static IS_WORK_DIRECTORY_CREATED: boolean = false;

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
      return q.reject<storageTypes.PackageHashToBlobInfoMap>(
        diffErrorUtils.diffError(diffErrorUtils.ErrorCode.InvalidArguments, "Package information missing")
      );
    }

    const manifestPromise: Promise<PackageManifest> = this.getManifest(newPackage);
    const historyPromise: Promise<storageTypes.Package[]> = this._storage.getPackageHistory(accountId, appId, deploymentId);
    const newReleaseFilePromise: Promise<string> = this.downloadArchiveFromUrl(newPackage.blobUrl);
    let newFilePath: string;
    let extractedArchive: ExtractedArchive;

    return q
      .all<any>([manifestPromise, historyPromise, newReleaseFilePromise])
      .spread((newManifest: PackageManifest, history: storageTypes.Package[], downloadedArchiveFile: string) => {
        newFilePath = downloadedArchiveFile;
        const packagesToDiff: storageTypes.Package[] = this.getPackagesToDiff(
          history,
          newPackage.appVersion,
          newPackage.packageHash,
          newPackage.label
        );
        // getManifest resolves null when the manifest cannot be fetched, in which case there is
        // nothing to diff against and the release simply ends up without a diff map.
        if (!newManifest || !packagesToDiff || !packagesToDiff.length) {
          return q<DiffBlobInfo[]>([]);
        }

        const manifestPromises: Promise<PackageWithManifest>[] = packagesToDiff.map(
          (appPackage: storageTypes.Package): Promise<PackageWithManifest> => {
            if (!appPackage || appPackage.packageHash === newPackage.packageHash) {
              // Same package, so there is nothing to diff against.
              return q<PackageWithManifest>({ appPackage: appPackage, manifest: null });
            }

            return this.getManifest(appPackage).then((manifest?: PackageManifest) => {
              return { appPackage: appPackage, manifest: manifest };
            });
          }
        );

        return q.all(manifestPromises).then((packagesWithManifests: PackageWithManifest[]) => {
          // Consecutive releases usually touch the same handful of files, so diffing several of
          // them against this release yields the same changed-entry set and therefore a
          // byte-identical archive. Build each distinct archive once and point every package
          // hash that resolves to it at the same blob.
          const archiveGroups = new Map<string, ArchiveGroup>();

          packagesWithManifests.forEach((packageWithManifest: PackageWithManifest) => {
            if (!packageWithManifest.manifest) {
              return;
            }

            const diff: IArchiveDiff = PackageDiffer.generateDiff(
              packageWithManifest.manifest.toMap(),
              newManifest.toMap()
            );

            if (diff.deletedFiles.length === 0 && diff.newOrUpdatedEntries.size === 0) {
              return;
            }

            const signature: string = PackageDiffer.getDiffSignature(diff);
            const existingGroup: ArchiveGroup = archiveGroups.get(signature);

            if (existingGroup) {
              existingGroup.packageHashes.push(packageWithManifest.appPackage.packageHash);
            } else {
              archiveGroups.set(signature, { diff: diff, packageHashes: [packageWithManifest.appPackage.packageHash] });
            }
          });

          if (!archiveGroups.size) {
            return q<DiffBlobInfo[]>([]);
          }

          // Unpack the release once up front. Every archive below pulls its entries from this one
          // extraction instead of decompressing the release again for each diff.
          return PackageDiffer.extractArchive(newFilePath).then((extracted: ExtractedArchive) => {
            extractedArchive = extracted;

            const groupPromises: Promise<DiffBlobInfo[]>[] = [];
            archiveGroups.forEach((group: ArchiveGroup) => {
              groupPromises.push(
                this.buildDiffArchive(group.diff, extractedArchive)
                  .then((diffArchiveFilePath?: string): Promise<storageTypes.BlobInfo> => {
                    if (diffArchiveFilePath) {
                      return this.uploadDiffArchiveBlob(security.generateSecureKey(accountId), diffArchiveFilePath);
                    }

                    return q(<storageTypes.BlobInfo>null);
                  })
                  .then((blobInfo: storageTypes.BlobInfo): DiffBlobInfo[] => {
                    if (!blobInfo) {
                      return [];
                    }

                    return group.packageHashes.map((packageHash: string): DiffBlobInfo => {
                      return { packageHash: packageHash, blobInfo: blobInfo };
                    });
                  })
              );
            });

            return q.all(groupPromises).then((groupedDiffBlobInfo: DiffBlobInfo[][]) => {
              return groupedDiffBlobInfo.reduce(
                (allDiffBlobInfo: DiffBlobInfo[], group: DiffBlobInfo[]) => allDiffBlobInfo.concat(group),
                []
              );
            });
          });
        });
      })
      .then((diffBlobInfoList: DiffBlobInfo[]) => {
        if (diffBlobInfoList && diffBlobInfoList.length) {
          let diffPackageMap: storageTypes.PackageHashToBlobInfoMap = null;
          diffBlobInfoList.forEach((diffBlobInfo: DiffBlobInfo) => {
            if (diffBlobInfo && diffBlobInfo.blobInfo) {
              diffPackageMap = diffPackageMap || {};
              diffPackageMap[diffBlobInfo.packageHash] = diffBlobInfo.blobInfo;
            }
          });

          return diffPackageMap;
        } else {
          return q<storageTypes.PackageHashToBlobInfoMap>(null);
        }
      })
      .finally(() => {
        // The release archive and its extraction are large, so drop them even when diffing failed
        // partway through.
        PackageDiffer.removeExtractedArchive(extractedArchive);

        if (newFilePath) {
          try {
            fs.unlinkSync(newFilePath);
          } catch (error) {
            console.error("Error occurred while unlinking downloaded archive:", error);
          }
        }
      })
      .catch(diffErrorUtils.diffErrorHandler);
  }

  public generateDiffArchive(oldManifest: PackageManifest, newManifest: PackageManifest, newArchiveFilePath: string): Promise<string> {
    if (!oldManifest || !newManifest) {
      return q<string>(null);
    }

    const diff: IArchiveDiff = PackageDiffer.generateDiff(oldManifest.toMap(), newManifest.toMap());
    if (diff.deletedFiles.length === 0 && diff.newOrUpdatedEntries.size === 0) {
      return q<string>(null);
    }

    let extractedArchive: ExtractedArchive;

    return PackageDiffer.extractArchive(newArchiveFilePath)
      .then((extracted: ExtractedArchive) => {
        extractedArchive = extracted;
        return this.buildDiffArchive(diff, extractedArchive);
      })
      .finally(() => {
        PackageDiffer.removeExtractedArchive(extractedArchive);
      });
  }

  // Unpacks the release once so that building several diffs from it does not decompress the same
  // entries over and over. Callers own the returned directory and must remove it.
  private static extractArchive(archiveFilePath: string): Promise<ExtractedArchive> {
    const deferred: q.Deferred<ExtractedArchive> = q.defer<ExtractedArchive>();

    PackageDiffer.ensureWorkDirectoryExists();

    const directoryPath: string = path.join(PackageDiffer.WORK_DIRECTORY_PATH, "extracted_" + PackageDiffer.randomString(20));
    fs.mkdirSync(directoryPath, { recursive: true });

    const entries: ExtractedEntry[] = [];
    let pendingWrites: number = 0;
    let enumerationComplete: boolean = false;
    let failed: boolean = false;

    const fail = (error: any): void => {
      if (!failed) {
        failed = true;
        deferred.reject(error);
      }
    };

    const resolveIfComplete = (): void => {
      if (enumerationComplete && pendingWrites === 0 && !failed) {
        deferred.resolve({ directoryPath: directoryPath, entries: entries });
      }
    };

    yauzl.open(archiveFilePath, (error?: any, zipFile?: yauzl.ZipFile): void => {
      if (error) {
        fail(error);
        return;
      }

      zipFile
        .on("error", fail)
        .on("entry", (entry: yauzl.IEntry): void => {
          // Recorded during enumeration rather than on write completion so that entries keep
          // archive order no matter what order the writes finish in.
          const extractedEntry: ExtractedEntry = {
            fileName: entry.fileName,
            isDirectory: /\/$/.test(entry.fileName),
            filePath: null,
          };
          entries.push(extractedEntry);

          if (extractedEntry.isDirectory) {
            return;
          }

          // Entry names come from an uploaded archive, so refuse any that would write outside the
          // extraction directory rather than trusting them.
          const filePath: string = path.join(directoryPath, entry.fileName);
          if (!path.resolve(filePath).startsWith(path.resolve(directoryPath) + path.sep)) {
            fail(
              diffErrorUtils.diffError(
                diffErrorUtils.ErrorCode.Other,
                "Archive entry would be written outside the extraction directory: " + entry.fileName
              )
            );
            return;
          }

          pendingWrites++;
          zipFile.openReadStream(entry, (error?: any, readStream?: stream.Readable): void => {
            if (error) {
              fail(error);
              return;
            }

            fs.mkdirSync(path.dirname(filePath), { recursive: true });

            readStream.pipe(fs.createWriteStream(filePath)).on("close", (): void => {
              extractedEntry.filePath = filePath;
              pendingWrites--;
              resolveIfComplete();
            });
          });
        })
        .on("close", (): void => {
          enumerationComplete = true;
          resolveIfComplete();
        });
    });

    return deferred.promise;
  }

  private buildDiffArchive(diff: IArchiveDiff, extractedArchive: ExtractedArchive): Promise<string> {
    return Promise<string>(
      (resolve: (value?: string | Promise<string>) => void, reject: (reason: any) => void, notify: (progress: any) => void): void => {
        if (diff.deletedFiles.length === 0 && diff.newOrUpdatedEntries.size === 0) {
          resolve(null);
          return;
        }

        PackageDiffer.ensureWorkDirectoryExists();

        const diffFilePath = path.join(PackageDiffer.WORK_DIRECTORY_PATH, "diff_" + PackageDiffer.randomString(20) + ".zip");
        const writeStream: stream.Writable = fs.createWriteStream(diffFilePath);
        const diffFile = new yazl.ZipFile();

        // Entries are read back from the extraction directory, so a missing or unreadable file
        // surfaces here. Without these the promise would never settle and diffing would hang.
        diffFile.outputStream.on("error", reject);
        writeStream.on("error", reject);

        diffFile.outputStream.pipe(writeStream).on("close", (): void => {
          resolve(diffFilePath);
        });

        const json: string = JSON.stringify({ deletedFiles: diff.deletedFiles });
        const readStream: stream.Readable = streamifier.createReadStream(json);
        diffFile.addReadStream(readStream, PackageDiffer.MANIFEST_FILE_NAME);

        extractedArchive.entries.forEach((entry: ExtractedEntry): void => {
          if (!PackageDiffer.isEntryInMap(entry.fileName, /*hash*/ null, diff.newOrUpdatedEntries, /*requireContentMatch*/ false)) {
            return;
          } else if (entry.isDirectory) {
            diffFile.addEmptyDirectory(entry.fileName);
            return;
          }

          diffFile.addFile(entry.filePath, entry.fileName);
        });

        diffFile.end();
      }
    );
  }

  private static removeExtractedArchive(extractedArchive: ExtractedArchive): void {
    if (!extractedArchive) {
      return;
    }

    try {
      fs.rmSync(extractedArchive.directoryPath, { recursive: true, force: true });
    } catch (error) {
      console.error("Error occurred while removing extracted archive:", error);
    }
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

  private getManifest(appPackage: storageTypes.Package): Promise<PackageManifest> {
    return Promise(
      (resolve: (manifest: PackageManifest) => void, reject: (error: any) => void, notify: (progress: any) => void): void => {
        if (!appPackage || !appPackage.manifestBlobUrl) {
          resolve(null);
          return;
        }

        const req: superagent.Request = superagent
          .get(appPackage.manifestBlobUrl)
          .buffer(true)
          .parse(superagent.parse.text);

        req.end((err, res) => {
          if (err) {
            resolve(null);
            return;
          }

          if (!res.text) {
            resolve(null);
            return;
          }

          try {
            const manifest = PackageManifest.deserialize(res.text);
            resolve(manifest);
          } catch (e) {
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
    if (!history || !history.length) {
      return null;
    }

    // We assume that the new package has been released and already is in history.
    // Only pick the packages that are released before the new package to generate diffs.
    let foundNewPackageInHistory: boolean = false;
    const validPackages: storageTypes.Package[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (!foundNewPackageInHistory) {
        foundNewPackageInHistory = history[i].label === newPackageLabel;
        continue;
      }

      if (validPackages.length === this._maxPackagesToDiff) {
        break;
      }

      const isMatchingAppVersion: boolean = PackageDiffer.isMatchingAppVersion(appVersion, history[i].appVersion);
      if (isMatchingAppVersion && history[i].packageHash !== newPackageHash) {
        validPackages.push(history[i]);
      }
    }

    // maintain the order of release.
    return validPackages.reverse();
  }

  // Identifies the archive a diff produces. The bytes are pulled from the new release by entry
  // name, so the names plus the deleted-file manifest fully determine the output; the old hashes
  // do not. deletedFiles is compared in order because it is serialized into the manifest as-is.
  private static getDiffSignature(diff: IArchiveDiff): string {
    const newOrUpdatedNames: string[] = [];
    diff.newOrUpdatedEntries.forEach((hash: string, name: string): void => {
      newOrUpdatedNames.push(name);
    });

    return crypto
      .createHash("sha256")
      .update(JSON.stringify({ deletedFiles: diff.deletedFiles, newOrUpdatedEntries: newOrUpdatedNames.sort() }))
      .digest("hex");
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
    if (!PackageDiffer.IS_WORK_DIRECTORY_CREATED) {
      if (!fs.existsSync(PackageDiffer.WORK_DIRECTORY_PATH)) {
        fs.mkdirSync(PackageDiffer.WORK_DIRECTORY_PATH);
      }

      // Memoize this check to avoid unnecessary file system access.
      PackageDiffer.IS_WORK_DIRECTORY_CREATED = true;
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
