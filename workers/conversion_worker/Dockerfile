FROM node:22-bookworm-slim AS base

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    CONVERSION_WORKER_MODE=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
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

COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
  && corepack prepare pnpm@10.28.0 --activate \
  && pnpm install --frozen-lockfile --prod=false

COPY . .
RUN pnpm build

EXPOSE 3000

CMD ["sh", "-c", "workers/conversion_worker/verify-runtime.sh && pnpm start"]
