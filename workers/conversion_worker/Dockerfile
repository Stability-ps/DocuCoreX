# Preferred Render settings:
# - Root Directory: empty / repository root
# - Dockerfile Path: workers/conversion_worker/Dockerfile
# - Docker Context: .
#
# Compatibility mode:
# This Dockerfile also works when Render is accidentally configured with
# Root Directory = workers/conversion_worker. In that case the Docker build
# context cannot see package.json/pnpm-lock.yaml, so the image checks out the
# full repository before building the worker.
FROM node:22-bookworm-slim AS base

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    CONVERSION_WORKER_MODE=true

ARG DOCUCOREX_REPO_URL=https://github.com/Stability-ps/DocuCoreX.git
ARG DOCUCOREX_GIT_REF=main

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    ghostscript \
    libreoffice \
    ocrmypdf \
    poppler-utils \
    python3 \
    qpdf \
    tesseract-ocr \
    tesseract-ocr-eng \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN git clone --depth 1 --branch "$DOCUCOREX_GIT_REF" "$DOCUCOREX_REPO_URL" /app

RUN corepack enable \
  && corepack prepare pnpm@10.28.0 --activate \
  && pnpm install --frozen-lockfile --prod=false

RUN pnpm build

EXPOSE 3000

CMD ["sh", "-c", "sh workers/conversion_worker/verify-runtime.sh && pnpm start"]
