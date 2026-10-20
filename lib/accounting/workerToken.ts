/** Thrown before any worker call when the token is absent — never silently omitted. */
export class WorkerTokenMissingError extends Error {
  constructor() {
    super(
      "ACCOUNTING_WORKER_TOKEN is not set in this runtime, so no Authorization header can be sent. " +
        "This is a server configuration error — the request was not attempted.",
    );
    this.name = "WorkerTokenMissingError";
  }
}
