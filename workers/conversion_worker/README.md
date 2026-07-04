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
- Dockerfile path: `workers/conversion_worker/Dockerfile`
- Docker context: repository root
- Health check path: `/api/conversion-worker/health`

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
