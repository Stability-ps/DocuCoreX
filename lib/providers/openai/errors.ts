// Dependency-free OpenAI error helpers (safe to unit-test in isolation). None of
// these surface the response body, request content, or any key material.

export type OpenAiRequestError = Error & { status?: number; code?: string | null };

// Extract the OpenAI error `code`/`type` from a response body WITHOUT returning
// any of the body text (which can contain a masked key).
export function openAiErrorCodeFromBody(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { code?: string; type?: string } };
    return parsed?.error?.code ?? parsed?.error?.type ?? null;
  } catch {
    return null;
  }
}

// A safe error message built ONLY from status + code (no body/key/content).
export function safeOpenAiErrorMessage(status: number, code: string | null): string {
  return `OpenAI request failed (HTTP ${status}${code ? `, ${code}` : ""})`;
}
