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

Do not set Root Directory to `workers/conversion_worker`. The worker Dockerfile builds the existing DocuCoreX Next.js job processor, so the Docker build context must include `package.json`, `pnpm-lock.yaml`, `app/`, `lib/`, and `components/` from the repository root.

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
