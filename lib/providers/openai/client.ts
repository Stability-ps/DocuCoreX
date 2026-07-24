// Thin OpenAI chat/completions client. The key is read from the environment at
// call time and never logged. Request/response *shaping* lives in pure helpers
// (see vision-ocr.ts / extraction.ts) so it can be unit-tested without the API.

import { DEFAULT_OCR_MODEL, estimateCostUsd } from "@/lib/providers/openai/models";

export type OpenAiUsage = { promptTokens: number; completionTokens: number; totalTokens: number };

export type OpenAiCompletion = {
  content: string;
  usage: OpenAiUsage;
  model: string;
};

export function openAiModel(): string {
  return process.env.OPENAI_OCR_MODEL || process.env.OPENAI_MODEL || DEFAULT_OCR_MODEL;
}

export function isOpenAiConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

// Normalise the raw API usage block into our shape and attach an estimated cost.
export function usageWithCost(model: string, usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined) {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  return {
    usage: { promptTokens, completionTokens, totalTokens: usage?.total_tokens ?? promptTokens + completionTokens },
    estimatedCostUsd: estimateCostUsd({ model, inputTokens: promptTokens, outputTokens: completionTokens }),
  };
}

// LIVE call. Not exercised in unit tests (requires OPENAI_API_KEY + network).
export async function callOpenAi(body: Record<string, unknown>, signal?: AbortSignal): Promise<OpenAiCompletion> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured in this runtime.");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // Never include request content in the error — only status + a short reason.
    throw new Error(`OpenAI request failed (HTTP ${response.status}): ${detail.slice(0, 200)}`);
  }

  const json = (await response.json()) as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  return {
    content: json.choices?.[0]?.message?.content ?? "",
    usage: {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      totalTokens: json.usage?.total_tokens ?? 0,
    },
    model: json.model ?? String(body.model ?? ""),
  };
}
