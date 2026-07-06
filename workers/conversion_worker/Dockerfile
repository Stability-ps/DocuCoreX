# Render settings:
# - Root Directory: empty / repository root
# - Dockerfile Path: workers/conversion_worker/Dockerfile
# - Docker Context: .
#
# The build uses Render's checked-out commit via the build context (COPY .), NOT
# an in-image `git clone`. Cloning inside the image produced a constant layer that
# Docker cached forever, so new commits (e.g. /api/ocr-text) never reached the
# deployed build. COPY invalidates whenever any source file changes, so the build
# always matches the checked-out commit.
FROM node:22-bookworm-slim AS base

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    CONVERSION_WORKER_MODE=true

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

# Copy the checked-out commit from Render's build context (no git clone).
COPY . /app

# Build provenance + a HARD guard: fail the build if the new code is not present,
# so stale cache / wrong context can never deploy an old app silently.
RUN echo "=== conversion-worker build provenance ===" \
  && (git rev-parse HEAD 2>/dev/null || echo "commit: unavailable (.git not in build context)") \
  && echo "--- app/api/ocr-text ---" \
  && ls -la app/api/ocr-text \
  && test -f app/api/ocr-text/route.ts

RUN corepack enable \
  && corepack prepare pnpm@10.28.0 --activate \
  && pnpm install --frozen-lockfile --prod=false

RUN pnpm build

EXPOSE 3000

CMD ["sh", "-c", "sh workers/conversion_worker/verify-runtime.sh && pnpm start"]
