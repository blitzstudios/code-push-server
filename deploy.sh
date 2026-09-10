#!/bin/sh

# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

# wwwroot is the shared file share, so the rm below wipes it for every instance at once.
# Without set -e a failed install or build falls straight through to it and leaves the
# fleet with no application files and no slot to roll back to.
set -e

cd api
npm install # Required because npm ci will install only prod dependencies because of app services environment
npm run clean
npm run build

rm -rf /home/site/wwwroot/*
cp -r /home/site/repository/api/* /home/site/wwwroot/
