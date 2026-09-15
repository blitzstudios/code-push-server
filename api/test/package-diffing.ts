// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AzureStorage } from "../script/storage/azure-storage";
import { JsonStorage } from "../script/storage/json-storage";
import * as assert from "assert";
import * as diffErrorUtils from "../script/utils/diff-error-handling";
import * as express from "express";
import * as fs from "fs";
import * as hashUtils from "../script/utils/hash-utils";
import * as http from "http";
import * as os from "os";
import * as packageDiffing from "../script/utils/package-diffing";
import * as path from "path";
import * as q from "q";
import * as shortid from "shortid";
import * as storage from "../script/storage/storage";
import * as stream from "stream";
import * as utils from "./utils";
import * as yauzl from "yauzl";
import clone = storage.clone;
import PackageDiffer = packageDiffing.PackageDiffer;
import PackageManifest = hashUtils.PackageManifest;
import Pend = require("pend");
import Promise = q.Promise;

describe("Package diffing with JSON storage", () => packageDiffTests(JsonStorage));

if (process.env.TEST_AZURE_STORAGE) {
  describe("Package diffing with Azure Storage", () => packageDiffTests(AzureStorage));
}

interface PackageInfo {
  packageHash: string;
  blobUrl: string;
  manifestBlobUrl: string;
}

function packageDiffTests(StorageType: new (...args: any[]) => storage.Storage): void {
  const TEST_ARCHIVE_FILE_NAMES = ["test.zip", "test2.zip", "test3.zip", "test4.zip"];
  const TEST_ARCHIVE_FILE_PATH = path.join(__dirname, "resources", TEST_ARCHIVE_FILE_NAMES[0]);
  const TEST_ARCHIVE_WITH_FOLDERS_FILE_PATH = path.join(__dirname, "resources", "testdirectories.zip");

  const TEST_ZIP_HASH = "540fed8df3553079e81d1353c5cc4e3cac7db9aea647a85d550f646e8620c317";
  const TEST_ZIP_MANIFEST_HASH = "9e0499ce7df5c04cb304c9deed684dc137fc603cb484a5b027478143c595d80b";
  const HASH_A = "418dd73df63bfe1dc9b1d126d340ccf4941198ccf573eff190a6ff8dc69e87e4";
  const HASH_B = "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d";
  const HASH_C = "2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6";
  const HASH_D = "18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4";
  const MANIFEST_HASH = "9a5b5530de83276462aba1f936a7d341629dddfa86705cf4b8e84365bd828c08";
  const FOLDER_A_HASH = "c8e61e0c7e666745a4066a42ef37fca0ca519a52f695201bd387fbcb4e019cb2";
  const FOLDER_B_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const HOT_CODE_PUSH_JSON_HASH = "3a2de62a9c2b64b3ac2ccdfd113a0c758e5acb66882fdf270e3f36ecc417a96d";

  var storage: storage.Storage;
  var packageDiffingUtils: PackageDiffer;

  // Spin up a server to serve the blob.
  var server: http.Server;
  before(() => {
    storage = new StorageType();
    packageDiffingUtils = new PackageDiffer(storage, /*maxPackagesToDiff*/ 5);
    var app = express();
    app.use("/", express.static(path.join(__dirname, "resources")));
    var port = 3000;

    server = app.listen(port);
  });

  // Kill the server.
  after(() => {
    server.close();
  });

  describe("Package diffing utility (general)", () => {
    it("generates an incremental update package", (done) => {
      var oldManifest = new PackageManifest(
        new Map<string, string>()
          .set("a.txt", HASH_A) // This file is removed in the new manifest.  The diff's hotcodepush.json file will reference this file.
          .set("b.txt", HASH_B) // This file is unchanged in the new manifest and will not be present in the diff.
          .set("c.txt", "previoushash")
      ); // This file will change in the new manifest.  The diff will contain the newer version of this file.
      var newManifest = new PackageManifest(new Map<string, string>().set("b.txt", HASH_B).set("c.txt", HASH_C).set("d.txt", HASH_D)); // This file is new as of the new manifest.  The diff will contain this file.
      var expectedDiffContents = new Map<string, string>()
        .set("c.txt", HASH_C)
        .set("d.txt", HASH_D)
        .set("hotcodepush.json", MANIFEST_HASH);

      packageDiffingUtils
        .generateDiffArchive(oldManifest, newManifest, TEST_ARCHIVE_FILE_PATH)
        .done((diffArchiveFilePath: string): void => {
          fs.exists(diffArchiveFilePath, (exists: boolean) => {
            assert.ok(exists);

            // Now verify that the diff package contents are correct.
            yauzl.open(diffArchiveFilePath, (error?: any, zipFile?: yauzl.ZipFile): void => {
              if (error) {
                throw error;
              }

              var pend = new Pend();

              zipFile
                .on("error", (error: any): void => {
                  throw error;
                })
                .on("entry", (entry: yauzl.IEntry): void => {
                  zipFile.openReadStream(entry, (error?: any, readStream?: stream.Readable): void => {
                    if (error) {
                      throw error;
                    }

                    pend.go((callback: (error?: any) => void): void => {
                      hashUtils
                        .hashStream(readStream)
                        .then((actualHash: string) => {
                          var expectedHash: string = expectedDiffContents.get(entry.fileName);
                          var error: Error;

                          if (actualHash !== expectedHash) {
                            error = new Error(
                              'The hash did not match for file "' +
                                entry.fileName +
                                '".  Expected hash:  ' +
                                expectedHash +
                                ".  Actual hash:  " +
                                actualHash +
                                "."
                            );
                          }

                          expectedDiffContents.delete(entry.fileName);

                          callback(error);
                        }, callback)
                        .done();
                    });
                  });
                })
                .on("close", (): void => {
                  pend.wait((error?: any): void => {
                    if (error) {
                      throw error;
                    }

                    if (expectedDiffContents.size !== 0) {
                      throw new Error("The diff archive contents were incorrect.");
                    }

                    fs.unlinkSync(diffArchiveFilePath);

                    done();
                  });
                });
            });
          });
        });
    });

    it("generates an incremental update package with new folders", (done) => {
      var oldManifest = new PackageManifest(new Map<string, string>().set("www/folderA/", FOLDER_A_HASH));
      var newManifest = new PackageManifest(
        new Map<string, string>().set("www/folderA/", FOLDER_A_HASH).set("www/folderB/", FOLDER_B_HASH)
      ); // This folder is a new folder that did not appear in the previous package manifest;
      var expectedDiffContents = new Map<string, string>()
        .set("www/folderB/", FOLDER_B_HASH)
        .set("hotcodepush.json", HOT_CODE_PUSH_JSON_HASH);

      packageDiffingUtils
        .generateDiffArchive(oldManifest, newManifest, TEST_ARCHIVE_WITH_FOLDERS_FILE_PATH)
        .done((diffArchiveFilePath: string): void => {
          fs.exists(diffArchiveFilePath, (exists: boolean) => {
            assert.ok(exists);

            // Now verify that the diff package contents are correct.
            yauzl.open(diffArchiveFilePath, (error?: any, zipFile?: yauzl.ZipFile): void => {
              if (error) {
                throw error;
              }

              var pend = new Pend();

              zipFile
                .on("error", (error: any): void => {
                  throw error;
                })
                .on("entry", (entry: yauzl.IEntry): void => {
                  zipFile.openReadStream(entry, (error?: any, readStream?: stream.Readable): void => {
                    if (error) {
                      throw error;
                    }

                    pend.go((callback: (error?: any) => void): void => {
                      hashUtils
                        .hashStream(readStream)
                        .then((actualHash: string) => {
                          var expectedHash: string = expectedDiffContents.get(entry.fileName);
                          var error: Error;

                          if (actualHash !== expectedHash) {
                            error = new Error(
                              'The hash did not not match for file "' +
                                entry.fileName +
                                '".  Expected hash:  ' +
                                expectedHash +
                                ".  Actual hash:  " +
                                actualHash +
                                "."
                            );
                          }

                          expectedDiffContents.delete(entry.fileName);

                          callback(error);
                        }, callback)
                        .done();
                    });
                  });
                })
                .on("close", (): void => {
                  pend.wait((error?: any): void => {
                    if (error) {
                      throw error;
                    }

                    if (expectedDiffContents.size !== 0) {
                      throw new Error("The diff archive contents were incorrect.");
                    }

                    fs.unlinkSync(diffArchiveFilePath);

                    done();
                  });
                });
            });
          });
        });
    });
  });

  if (StorageType === AzureStorage) {
    // These tests can only be run against azure storage because diffing downloads blob from url
    // while json storage serves the blobs from memory, which for some reason yazl/yauzl treats as corrupt file.
    describe("Package diffing utility (with Azure)", () => {
      var account: storage.Account;
      var app: storage.App;
      var appPackages: storage.Package[] = [];
      var deployment: storage.Deployment;
      var infoList: PackageInfo[];

      before(() => {
        var packageInfoPromises: Promise<PackageInfo>[] = [];
        TEST_ARCHIVE_FILE_NAMES.forEach((fileName: string) => {
          var testFilePath: string = path.join(__dirname, "resources", fileName);
          packageInfoPromises.push(uploadAndGetPackageInfo(testFilePath));
        });

        return q
          .all(packageInfoPromises)
          .then((allPackageInfo: PackageInfo[]) => {
            infoList = allPackageInfo;
            account = utils.makeAccount();
            return storage.addAccount(account);
          })
          .then((accountId: string) => {
            account.id = accountId;
            app = utils.makeStorageApp();
            return storage.addApp(account.id, app);
          })
          .then((addedApp: storage.App) => {
            app.id = addedApp.id;
            deployment = utils.makeStorageDeployment();
            return storage.addDeployment(account.id, app.id, deployment);
          })
          .then((deploymentId: string) => {
            deployment.id = deploymentId;
            var commitPromise: Promise<void> = q<void>(null);
            infoList.forEach((info: PackageInfo) => {
              var madePackage = utils.makePackage("1.0.0", false, info.packageHash);
              madePackage.blobUrl = info.blobUrl;
              madePackage.manifestBlobUrl = info.manifestBlobUrl;
              commitPromise = commitPromise
                .then(() => storage.commitPackage(account.id, app.id, deployment.id, madePackage))
                .then((commitedPackage: storage.Package) => {
                  madePackage.label = commitedPackage.label;
                  appPackages.push(madePackage);
                });
            });

            return commitPromise;
          });
      });

      it("generateDiffPackageMap throws error for null package", (done) => {
        packageDiffingUtils
          .generateDiffPackageMap(account.id, app.id, deployment.id, /*newPackage*/ null)
          .done(failOnCallSucceeded, (error: diffErrorUtils.DiffError) => {
            assert.equal(error.code, diffErrorUtils.ErrorCode.InvalidArguments);
            done();
          });
      });

      it("generateDiffPackageMap throws error for missing blobUrl", (done) => {
        var clonedPackage: storage.Package = clone(appPackages[1]);
        clonedPackage.blobUrl = "";
        packageDiffingUtils
          .generateDiffPackageMap(account.id, app.id, deployment.id, clonedPackage)
          .done(failOnCallSucceeded, (error: diffErrorUtils.DiffError) => {
            assert.equal(error.code, diffErrorUtils.ErrorCode.InvalidArguments);
            done();
          });
      });

      it("generateDiffPackageMap throws error for missing manifestBlobUrl", (done) => {
        var clonedPackage: storage.Package = clone(appPackages[1]);
        clonedPackage.manifestBlobUrl = "";
        packageDiffingUtils
          .generateDiffPackageMap(account.id, app.id, deployment.id, clonedPackage)
          .done(failOnCallSucceeded, (error: diffErrorUtils.DiffError) => {
            assert.equal(error.code, diffErrorUtils.ErrorCode.InvalidArguments);
            done();
          });
      });

      it("generateDiffPackageMap returns null for no package history", (done) => {
        var deployment2: storage.Deployment = utils.makeStorageDeployment();
        storage
          .addDeployment(account.id, app.id, deployment2)
          .then((depId: string) => {
            deployment2.id = depId;
            return packageDiffingUtils.generateDiffPackageMap(account.id, app.id, deployment2.id, appPackages[1]);
          })
          .done((diffPackageMap: storage.PackageHashToBlobInfoMap) => {
            assert(!diffPackageMap);
            done();
          });
      });

      it("generateDiffPackageMap returns null for first package in history", (done) => {
        packageDiffingUtils
          .generateDiffPackageMap(account.id, app.id, deployment.id, appPackages[0])
          .done((diffPackageMap: storage.PackageHashToBlobInfoMap) => {
            assert(!diffPackageMap);
            done();
          });
      });

      it("generateDiffPackageMap returns null for a release with no matching app version in history", (done) => {
        var deployment2: storage.Deployment = utils.makeStorageDeployment();
        var p1: storage.Package;
        var p2: storage.Package;
        var p3: storage.Package;
        storage
          .addDeployment(account.id, app.id, deployment2)
          .then((depId: string) => {
            deployment2.id = depId;
            p1 = clone(appPackages[0]);
            return storage.commitPackage(account.id, app.id, deployment2.id, p1);
          })
          .then((returnPackage: storage.Package) => {
            p2 = clone(appPackages[1]);
            p2.appVersion = "2.0.0";
            return storage.commitPackage(account.id, app.id, deployment2.id, p2);
          })
          .then((returnPackage: storage.Package) => {
            p3 = clone(appPackages[2]);
            p3.appVersion = "3.0.0";
            return storage.commitPackage(account.id, app.id, deployment2.id, p3);
          })
          .then((returnPackage: storage.Package) => {
            return packageDiffingUtils.generateDiffPackageMap(account.id, app.id, deployment2.id, p3);
          })
          .done((diffPackageMap: storage.PackageHashToBlobInfoMap) => {
            assert(!diffPackageMap);
            done();
          });
      });

      it("generateDiffPackageMap returns diff info for one package in history", (done) => {
        packageDiffingUtils
          .generateDiffPackageMap(account.id, app.id, deployment.id, appPackages[1])
          .done((diffPackageMap: storage.PackageHashToBlobInfoMap) => {
            assert(diffPackageMap);
            assert.equal(Object.keys(diffPackageMap).length, 1);
            assert(diffPackageMap[appPackages[0].packageHash]);
            done();
          });
      });

      it("generateDiffPackageMap returns multiple diffs for multiple packages in history", (done) => {
        packageDiffingUtils
          .generateDiffPackageMap(account.id, app.id, deployment.id, appPackages[3])
          .done((diffPackageMap: storage.PackageHashToBlobInfoMap) => {
            assert(diffPackageMap);
            assert.equal(Object.keys(diffPackageMap).length, 3);
            assert(diffPackageMap[appPackages[0].packageHash]);
            assert(diffPackageMap[appPackages[1].packageHash]);
            assert(diffPackageMap[appPackages[2].packageHash]);
            done();
          });
      });

      it("generateDiffPackageMap generates diff only against same app version in history", (done) => {
        var deployment2: storage.Deployment = utils.makeStorageDeployment();
        var p1: storage.Package;
        var p2: storage.Package;
        var p3: storage.Package;
        storage
          .addDeployment(account.id, app.id, deployment2)
          .then((depId: string) => {
            deployment2.id = depId;
            p1 = clone(appPackages[0]);
            return storage.commitPackage(account.id, app.id, deployment2.id, p1);
          })
          .then((returnPackage: storage.Package) => {
            p2 = clone(appPackages[1]);
            p2.appVersion = "2.0.0";
            return storage.commitPackage(account.id, app.id, deployment2.id, p2);
          })
          .then((returnPackage: storage.Package) => {
            p3 = clone(appPackages[2]);
            return storage.commitPackage(account.id, app.id, deployment2.id, p3);
          })
          .then((returnPackage: storage.Package) => {
            return packageDiffingUtils.generateDiffPackageMap(account.id, app.id, deployment2.id, p3);
          })
          .done((diffPackageMap: storage.PackageHashToBlobInfoMap) => {
            assert(diffPackageMap);
            assert.equal(Object.keys(diffPackageMap).length, 1);
            assert(diffPackageMap[p1.packageHash]);
            assert(!diffPackageMap[p2.packageHash]);
            done();
          });
      });

      it("generateDiffPackageMap generates diff only against similar app version(matching range) in history", (done) => {
        var deployment2: storage.Deployment = utils.makeStorageDeployment();
        var p1: storage.Package;
        var p2: storage.Package;
        var p3: storage.Package;
        storage
          .addDeployment(account.id, app.id, deployment2)
          .then((depId: string) => {
            deployment2.id = depId;
            p1 = clone(appPackages[0]);
            p1.appVersion = "1.*";
            return storage.commitPackage(account.id, app.id, deployment2.id, p1);
          })
          .then((returnPackage: storage.Package) => {
            p2 = clone(appPackages[1]);
            p2.appVersion = "1.3.0";
            return storage.commitPackage(account.id, app.id, deployment2.id, p2);
          })
          .then((returnPackage: storage.Package) => {
            p3 = clone(appPackages[2]);
            p3.appVersion = "1.x";
            return storage.commitPackage(account.id, app.id, deployment2.id, p3);
          })
          .then((returnPackage: storage.Package) => {
            return packageDiffingUtils.generateDiffPackageMap(account.id, app.id, deployment2.id, p3);
          })
          .done((diffPackageMap: storage.PackageHashToBlobInfoMap) => {
            assert(diffPackageMap);
            assert.equal(Object.keys(diffPackageMap).length, 2);
            assert(diffPackageMap[p1.packageHash]);
            assert(diffPackageMap[p2.packageHash]);
            done();
          });
      });
    });
  }

  function uploadAndGetPackageInfo(filePath: string): Promise<PackageInfo> {
    var info: PackageInfo = { packageHash: null, blobUrl: null, manifestBlobUrl: null };
    var manifest: PackageManifest;
    return hashUtils
      .generatePackageManifestFromZip(filePath)
      .then((retrievedManifest: PackageManifest) => {
        manifest = retrievedManifest;
        return manifest.computePackageHash();
      })
      .then((packageHash: string) => {
        info.packageHash = packageHash;
        var json: string = manifest.serialize();
        return storage.addBlob(shortid.generate(), utils.makeStreamFromString(json), json.length);
      })
      .then((blobId: string) => {
        return storage.getBlobUrl(blobId);
      })
      .then((savedManifestBlobUrl: string) => {
        info.manifestBlobUrl = savedManifestBlobUrl;
        return utils.getStreamAndSizeForFile(filePath);
      })
      .then((props: utils.FileProps) => {
        return storage.addBlob(shortid.generate(), props.stream, props.size);
      })
      .then((blobId: string) => {
        return storage.getBlobUrl(blobId);
      })
      .then((savedBlobUrl: string) => {
        info.blobUrl = savedBlobUrl;
        return info;
      });
  }

  function failOnCallSucceeded(result: any): any {
    throw new Error("Expected the promise to be rejected, but it succeeded with value " + (result ? JSON.stringify(result) : result));
  }
}

// Releases usually touch the same few files, so diffing several of them against one release
// produces the same archive over and over. These tests pin down that the differ builds each
// distinct archive once and still hands every history entry a diff. Unlike the
// generateDiffPackageMap suite above this needs no Azure, because the differ only has to read
// the release and manifests over HTTP and say how many archives it uploaded.
describe("Package diffing deduplication", () => {
  const PORT: number = 3001;
  const BASE_URL: string = "http://localhost:" + PORT;

  // Hashes of the files inside test.zip, which holds exactly b.txt, c.txt and d.txt.
  const HASH_B = "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d";
  const HASH_C = "2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6";
  const HASH_D = "18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4";

  interface Committed {
    account: storage.Account;
    app: storage.App;
    deployment: storage.Deployment;
    oldPackages: storage.Package[];
    newPackage: storage.Package;
  }

  // Counts archive uploads and hands back a distinct URL per upload. JsonStorage cannot be used
  // for this directly because it accumulates blobs into a string, which mangles zip bytes.
  class UploadCountingStorage extends JsonStorage {
    public uploadedBlobIds: string[] = [];

    public addBlob(blobId: string, blobStream: stream.Readable, streamLength: number): Promise<string> {
      this.uploadedBlobIds.push(blobId);

      return Promise<string>((resolve: (blobId: string) => void): void => {
        blobStream.on("data", (): void => undefined).on("end", (): void => resolve(blobId));
      });
    }

    public getBlobUrl(blobId: string): Promise<string> {
      return q(BASE_URL + "/blobs/" + blobId);
    }
  }

  var server: http.Server;
  var storageInstance: UploadCountingStorage;
  var differ: PackageDiffer;
  var servedManifests: { [name: string]: string } = {};

  before(() => {
    var app = express();
    app.use("/resources", express.static(path.join(__dirname, "resources")));
    app.get("/manifests/:name", (req: express.Request, res: express.Response) => {
      res.type("text/plain").send(servedManifests[req.params.name] || "");
    });

    server = app.listen(PORT);
  });

  after(() => {
    server.close();
  });

  function distinct<T>(values: T[]): T[] {
    var seen: T[] = [];
    values.forEach((value: T) => {
      if (seen.indexOf(value) < 0) {
        seen.push(value);
      }
    });

    return seen;
  }

  function serveManifest(prefix: string, map: Map<string, string>): string {
    var name: string = prefix + "_" + shortid.generate() + ".json";
    servedManifests[name] = new PackageManifest(map).serialize();

    return BASE_URL + "/manifests/" + name;
  }

  // Commits one package per supplied manifest, then a release whose contents are test.zip.
  function setUpDeployment(oldManifestMaps: Map<string, string>[]): Promise<Committed> {
    storageInstance = new UploadCountingStorage();
    differ = new PackageDiffer(storageInstance, /*maxPackagesToDiff*/ oldManifestMaps.length);

    var result = <Committed>{ oldPackages: [] };
    result.account = utils.makeAccount();

    return storageInstance
      .addAccount(result.account)
      .then((accountId: string) => {
        result.account.id = accountId;
        result.app = utils.makeStorageApp();
        return storageInstance.addApp(accountId, result.app);
      })
      .then((addedApp: storage.App) => {
        result.app.id = addedApp.id;
        result.deployment = utils.makeStorageDeployment();
        return storageInstance.addDeployment(result.account.id, result.app.id, result.deployment);
      })
      .then((deploymentId: string) => {
        result.deployment.id = deploymentId;

        // Commit sequentially so history order matches release order.
        var chain: Promise<void> = q<void>(null);
        oldManifestMaps.forEach((map: Map<string, string>, index: number) => {
          chain = chain.then(() => {
            var oldPackage: storage.Package = utils.makePackage("1.0.0", false, "oldhash" + index);
            oldPackage.blobUrl = BASE_URL + "/resources/test.zip";
            oldPackage.manifestBlobUrl = serveManifest("old" + index, map);

            return storageInstance
              .commitPackage(result.account.id, result.app.id, result.deployment.id, oldPackage)
              .then((committedPackage: storage.Package) => {
                oldPackage.label = committedPackage.label;
                result.oldPackages.push(oldPackage);
              });
          });
        });

        return chain;
      })
      .then(() => {
        var newPackage: storage.Package = utils.makePackage("1.0.0", false, "newhash");
        newPackage.blobUrl = BASE_URL + "/resources/test.zip";
        newPackage.manifestBlobUrl = serveManifest(
          "new",
          new Map<string, string>().set("b.txt", HASH_B).set("c.txt", HASH_C).set("d.txt", HASH_D)
        );

        return storageInstance
          .commitPackage(result.account.id, result.app.id, result.deployment.id, newPackage)
          .then((committedPackage: storage.Package) => {
            newPackage.label = committedPackage.label;
            result.newPackage = newPackage;
            return result;
          });
      });
  }

  function generateMap(committed: Committed): Promise<storage.PackageHashToBlobInfoMap> {
    return differ.generateDiffPackageMap(committed.account.id, committed.app.id, committed.deployment.id, committed.newPackage);
  }

  // Differs from the release in c.txt alone, so the diff holds c.txt plus the manifest.
  function changedCOnly(staleHash: string): Map<string, string> {
    return new Map<string, string>().set("b.txt", HASH_B).set("c.txt", staleHash).set("d.txt", HASH_D);
  }

  it("builds a single archive when several history entries produce the same diff", (done) => {
    var oldManifests: Map<string, string>[] = [changedCOnly("stale1"), changedCOnly("stale2"), changedCOnly("stale3")];

    var committed: Committed;
    setUpDeployment(oldManifests)
      .then((result: Committed) => {
        committed = result;
        return generateMap(committed);
      })
      .done((diffPackageMap: storage.PackageHashToBlobInfoMap) => {
        assert(diffPackageMap, "expected a diff package map");

        // Every history entry must still be offered a diff.
        assert.equal(Object.keys(diffPackageMap).length, oldManifests.length);
        committed.oldPackages.forEach((oldPackage: storage.Package) => {
          assert(diffPackageMap[oldPackage.packageHash], "no diff for " + oldPackage.packageHash);
        });

        // ...but the identical archive is only built and uploaded once.
        assert.equal(storageInstance.uploadedBlobIds.length, 1);

        var urls: string[] = committed.oldPackages.map((oldPackage: storage.Package) => diffPackageMap[oldPackage.packageHash].url);
        assert.equal(distinct(urls).length, 1, "identical diffs should share one blob");

        var sizes: number[] = committed.oldPackages.map((oldPackage: storage.Package) => diffPackageMap[oldPackage.packageHash].size);
        assert.equal(distinct(sizes).length, 1);

        done();
      }, done);
  });

  it("keeps archives separate when history entries produce different diffs", (done) => {
    var oldManifests: Map<string, string>[] = [
      changedCOnly("stale"),
      // Never had d.txt, so the diff carries d.txt instead of c.txt.
      new Map<string, string>().set("b.txt", HASH_B).set("c.txt", HASH_C),
      // Differs in b.txt and holds a file the release dropped, so the manifest differs too.
      new Map<string, string>().set("b.txt", "stale").set("c.txt", HASH_C).set("d.txt", HASH_D).set("gone.txt", "stale"),
    ];

    var committed: Committed;
    setUpDeployment(oldManifests)
      .then((result: Committed) => {
        committed = result;
        return generateMap(committed);
      })
      .done((diffPackageMap: storage.PackageHashToBlobInfoMap) => {
        assert(diffPackageMap, "expected a diff package map");
        assert.equal(Object.keys(diffPackageMap).length, oldManifests.length);
        assert.equal(storageInstance.uploadedBlobIds.length, oldManifests.length, "distinct diffs must not be merged");

        var urls: string[] = committed.oldPackages.map((oldPackage: storage.Package) => diffPackageMap[oldPackage.packageHash].url);
        assert.equal(distinct(urls).length, oldManifests.length);

        done();
      }, done);
  });

  // The release is unpacked to disk once per diff run, so a leak here would fill the host.
  function countExtractionDirectories(): number {
    var workDirectory: string = process.env.TEMP || process.env.TMPDIR || os.tmpdir();

    return fs.readdirSync(workDirectory).filter((name: string) => name.indexOf("extracted_") === 0).length;
  }

  it("removes the unpacked release once the diffs are built", (done) => {
    var before: number = countExtractionDirectories();

    setUpDeployment([changedCOnly("stale1"), changedCOnly("stale2")])
      .then((result: Committed) => generateMap(result))
      .done(() => {
        assert.equal(countExtractionDirectories(), before, "extraction directory was left behind");
        done();
      }, done);
  });

  it("collapses only the matching entries when diffs are mixed", (done) => {
    // Three entries share a diff; the other two are unique. Five diffs, three archives.
    var oldManifests: Map<string, string>[] = [
      changedCOnly("stale1"),
      new Map<string, string>().set("b.txt", HASH_B).set("c.txt", HASH_C),
      changedCOnly("stale2"),
      new Map<string, string>().set("b.txt", "stale").set("c.txt", HASH_C).set("d.txt", HASH_D).set("gone.txt", "stale"),
      changedCOnly("stale3"),
    ];

    var committed: Committed;
    setUpDeployment(oldManifests)
      .then((result: Committed) => {
        committed = result;
        return generateMap(committed);
      })
      .done((diffPackageMap: storage.PackageHashToBlobInfoMap) => {
        assert(diffPackageMap, "expected a diff package map");
        assert.equal(Object.keys(diffPackageMap).length, 5);
        assert.equal(storageInstance.uploadedBlobIds.length, 3);

        var urls: string[] = committed.oldPackages.map((oldPackage: storage.Package) => diffPackageMap[oldPackage.packageHash].url);
        assert.equal(distinct(urls).length, 3);

        // The three c.txt-only entries are indexes 0, 2 and 4.
        assert.equal(urls[0], urls[2]);
        assert.equal(urls[0], urls[4]);
        assert.notEqual(urls[0], urls[1]);
        assert.notEqual(urls[0], urls[3]);
        assert.notEqual(urls[1], urls[3]);

        done();
      }, done);
  });
});
