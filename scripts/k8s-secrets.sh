#!/bin/sh
# Create (or update) the coordinator's Secrets from the git-ignored .env. Run it yourself;
# values go straight from .env to the cluster and are never printed or committed.
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env"; exit 1; }
set -a; . ./.env; set +a
kubectl get namespace roloe >/dev/null 2>&1 || kubectl create namespace roloe
kubectl -n roloe create secret generic roloe-elastic \
  --from-literal=ELASTIC_URL="${ELASTIC_URL:-}" --from-literal=ELASTIC_API_KEY="${ELASTIC_API_KEY:-}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n roloe create secret generic roloe-otel \
  --from-literal=OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-}" --from-literal=DASH0_AUTH_TOKEN="${DASH0_AUTH_TOKEN:-}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
echo "Secrets roloe-elastic and roloe-otel are set in namespace roloe."
