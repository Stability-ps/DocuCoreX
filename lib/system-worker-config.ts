import { randomUUID } from "node:crypto";

type WorkerConfig = {
  environment: string;
  accountingWorkerUrl: string | null;
  conversionWorkerUrl: string | null;
  pdfPlumberUrl: string | null;
};

type Reachability = {
  url: string | null;
  reachable: boolean;
  status: number | null;
  error: string | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __docucorexWorkerStartupLoggedAt: string | undefined;
}

function normalizeUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/$/, "");
  }
}

export function getWorkerConfig(): WorkerConfig {
  const environment =
    process.env.VERCEL_ENV ||
    process.env.RENDER ||
    process.env.NODE_ENV ||
    "unknown";

  return {
    environment,
    accountingWorkerUrl: normalizeUrl(process.env.ACCOUNTING_WORKER_URL),
    conversionWorkerUrl: normalizeUrl(process.env.CONVERSION_WORKER_URL),
    pdfPlumberUrl: normalizeUrl(process.env.PDF_PLUMBER_URL),
  };
}

export function buildWorkerEndpoint(baseUrl: string, endpointPath: string): string {
  const normalizedPath = endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;
  return `${baseUrl.replace(/\/$/, "")}${normalizedPath}`;
}

export function createWorkerRequestId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

async function checkUrlReachability(url: string | null): Promise<Reachability> {
  if (!url) {
    return { url: null, reachable: false, status: null, error: "not_configured" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    let response = await fetch(url, { method: "HEAD", signal: controller.signal, cache: "no-store" });
    if (response.status === 405 || response.status === 404) {
      response = await fetch(url, { method: "GET", signal: controller.signal, cache: "no-store" });
    }
    const reachable = response.status > 0 && response.status < 500;
    return {
      url,
      reachable,
      status: response.status,
      error: reachable ? null : `http_${response.status}`,
    };
  } catch (error) {
    return {
      url,
      reachable: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function getWorkerReachability() {
  const config = getWorkerConfig();
  const [accountingWorker, conversionWorker, pdfPlumber] = await Promise.all([
    checkUrlReachability(config.accountingWorkerUrl),
    checkUrlReachability(config.conversionWorkerUrl),
    checkUrlReachability(config.pdfPlumberUrl),
  ]);
  return {
    environment: config.environment,
    accountingWorker,
    conversionWorker,
    pdfPlumber,
  };
}

export async function logWorkerStartupCheck(force = false) {
  const stamp = globalThis.__docucorexWorkerStartupLoggedAt;
  if (stamp && !force) return;
  globalThis.__docucorexWorkerStartupLoggedAt = new Date().toISOString();

  const config = getWorkerConfig();
  const reachability = await getWorkerReachability();
  console.info("docucorex.system.worker_startup_check", {
    checkedAt: globalThis.__docucorexWorkerStartupLoggedAt,
    environment: config.environment,
    ACCOUNTING_WORKER_URL: config.accountingWorkerUrl,
    CONVERSION_WORKER_URL: config.conversionWorkerUrl,
    PDF_PLUMBER_URL: config.pdfPlumberUrl,
    reachable: {
      accountingWorker: {
        url: reachability.accountingWorker.url,
        reachable: reachability.accountingWorker.reachable,
        status: reachability.accountingWorker.status,
        error: reachability.accountingWorker.error,
      },
      conversionWorker: {
        url: reachability.conversionWorker.url,
        reachable: reachability.conversionWorker.reachable,
        status: reachability.conversionWorker.status,
        error: reachability.conversionWorker.error,
      },
      pdfPlumber: {
        url: reachability.pdfPlumber.url,
        reachable: reachability.pdfPlumber.reachable,
        status: reachability.pdfPlumber.status,
        error: reachability.pdfPlumber.error,
      },
    },
  });
}
