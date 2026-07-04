# DocuCoreX Conversion Worker

This worker runs the same DocuCoreX job processor outside Vercel with native document/OCR tools installed.

## Runtime Dependencies

The Docker image installs and verifies:

- `ocrmypdf --version`
- `tesseract --version`
- `gs --version`
- `qpdf --version`
- English OCR language data: `tesseract-ocr-eng`
- LibreOffice headless for Office-to-PDF rendering
- Poppler utilities for PDF inspection

If any required dependency is missing, the worker exits during startup.

## Render Setup

Create a Render Web Service:

- Runtime: Docker
- Root Directory: leave empty / repository root
- Dockerfile path: `workers/conversion_worker/Dockerfile`
- Docker context: `.`
- Health check path: `/api/conversion-worker/health`

Preferred: do not set Root Directory to `workers/conversion_worker`. The worker Dockerfile builds the existing DocuCoreX Next.js job processor, so the Docker build context should include `package.json`, `pnpm-lock.yaml`, `app/`, `lib/`, and `components/` from the repository root.

Compatibility: if Render is already configured with Root Directory `workers/conversion_worker`, the Dockerfile can still build by cloning the full repository during the image build. This requires the GitHub repo to be accessible from Render. The default build args are:

- `DOCUCOREX_REPO_URL=https://github.com/Stability-ps/DocuCoreX.git`
- `DOCUCOREX_GIT_REF=main`

Required environment variables:

- `CONVERSION_WORKER_MODE=true`
- `CONVERSION_WORKER_SECRET=<strong shared secret>`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Set the Vercel frontend environment variables:

- `CONVERSION_WORKER_URL=https://<your-render-worker-host>`
- `CONVERSION_WORKER_SECRET=<same shared secret>`

With this configuration, Vercel forwards `/api/jobs/process` to the worker. OCR and LibreOffice do not run inside the Vercel frontend app.
