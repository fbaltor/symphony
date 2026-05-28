#!/usr/bin/env bash
# Deploy Symphony to Google Cloud Run.
#
# Required env vars:
#   GOOGLE_CLOUD_PROJECT  — GCP project ID (e.g. "my-project")
#
# Optional env vars (with defaults):
#   SYMPHONY_REGION       — GCP region (default: us-central1)
#   SYMPHONY_REPO         — Artifact Registry repo name (default: symphony)
#   SYMPHONY_SERVICE      — Cloud Run service name (default: symphony-orchestrator)
#   SYMPHONY_IMAGE_TAG    — Image tag (default: current git short SHA)
#
# Usage:
#   GOOGLE_CLOUD_PROJECT=my-project ./scripts/deploy.sh
#   GOOGLE_CLOUD_PROJECT=my-project SYMPHONY_REGION=us-east1 ./scripts/deploy.sh

set -euo pipefail

PROJECT="${GOOGLE_CLOUD_PROJECT:?GOOGLE_CLOUD_PROJECT is required}"
REGION="${SYMPHONY_REGION:-us-central1}"
REPO="${SYMPHONY_REPO:-symphony}"
SERVICE="${SYMPHONY_SERVICE:-symphony-orchestrator}"
TAG="${SYMPHONY_IMAGE_TAG:-$(git rev-parse --short HEAD)}"

IMAGE_REF="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}:${TAG}"
IMAGE_LATEST="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/${SERVICE}:latest"

echo "[symphony/deploy] building image ${IMAGE_REF}"
docker buildx build \
  --platform linux/amd64 \
  -t "${IMAGE_REF}" \
  -t "${IMAGE_LATEST}" \
  -f docker/Dockerfile \
  --build-arg "GIT_SHA=${TAG}" \
  --push \
  .

echo "[symphony/deploy] deploying Cloud Run service ${SERVICE} → ${PROJECT}"
# Use `gcloud run services update` (not `deploy`) to preserve scaling settings
# and explicitly pin min/max=1 on every revision (required for singleton lock).
gcloud run services update "${SERVICE}" \
  --project="${PROJECT}" \
  --region="${REGION}" \
  --image="${IMAGE_REF}" \
  --max-instances=1 \
  --min-instances=1 \
  --quiet

echo "[symphony/deploy] done — tag=${TAG}"
