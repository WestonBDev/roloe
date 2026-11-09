#!/bin/sh
# Pin the cluster to a commit (default: origin/main). Commit the change; Argo CD syncs it.
set -eu
cd "$(dirname "$0")/.."
git fetch -q origin
SHA="${1:-$(git rev-parse origin/main)}"
sed -i.bak -E "s/(name: ROLOE_REF, value: )\"[0-9a-f]*\"/\1\"$SHA\"/" deploy/coordinator.yaml && rm deploy/coordinator.yaml.bak
echo "ROLOE_REF pinned to $SHA"
