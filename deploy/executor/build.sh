#!/bin/sh
set -eu
cp /opt/template/package.json /opt/template/index.html /opt/template/vite.config.js /workspace/
ln -s /opt/template/node_modules /workspace/node_modules
cp -r /submission/src /workspace/src
if [ -d /submission/public ]; then cp -r /submission/public /workspace/public; fi
cd /workspace
exec node /opt/template/node_modules/vite/bin/vite.js build --configLoader runner
