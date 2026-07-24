// OpenAI vision OCR for scanned pages. The model is instructed to TRANSCRIBE
// only — never to invent or "correct" content — so the output can be validated
// deterministically downstream. Request shaping is pure/testable.

import { callOpenAi, openAiModel, usageWithCost, type OpenAiUsage } from "@/lib/providers/openai/client";
import { modelSupportsVision } from "@/lib/providers/openai/models";

const TRANSCRIBE_SYSTEM =
  "You are an OCR transcription engine. Transcribe the visible text of each page image EXACTLY as printed, " +
  "preserving numbers, dates and amounts verbatim. Do not summarise, translate, reformat, correct, or invent " +
  "any content. If text is illegible, output [illegible]. Return plain text only.";

type VisionMessage = {
  role: "system" | "user";
  content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: "low" | "high" } }>;
};

// Pure: build the chat/completions message array for a set of page images.
export function buildVisionMessages(imageDataUrls: string[], detail: "low" | "high" = "high"): VisionMessage[] {
  return [
    { role: "system", content: TRANSCRIBE_SYSTEM },
    {
      role: "user",
      content: [
        { type: "text", text: "Transcribe every page image below, in order. Separate pages with a form-feed." },
        ...imageDataUrls.map((url) => ({ type: "image_url", image_url: { url, detail } })),
      ],
    },
  ];
}

// Pure: assemble the request body (kept separate from the network call).
export function buildVisionBody(model: string, imageDataUrls: string[], detail: "low" | "high" = "high") {
  return {
    model,
    temperature: 0,
    max_tokens: 4096,
    messages: buildVisionMessages(imageDataUrls, detail),
  };
}

export type VisionOcrResult = { text: string; usage: OpenAiUsage; estimatedCostUsd: number; model: string };

// LIVE. Requires OPENAI_API_KEY + a vision-capable model.
export async function runVisionOcr(
  imageDataUrls: string[],
  options: { detail?: "low" | "high"; signal?: AbortSignal } = {},
): Promise<VisionOcrResult> {
  const model = openAiModel();
  if (!modelSupportsVision(model)) {
    throw new Error(`Configured model "${model}" does not support image input; set OPENAI_OCR_MODEL to a vision model.`);
  }
  const body = buildVisionBody(model, imageDataUrls, options.detail ?? "high");
  const completion = await callOpenAi(body, options.signal);
  const { usage, estimatedCostUsd } = usageWithCost(completion.model, {
    prompt_tokens: completion.usage.promptTokens,
    completion_tokens: completion.usage.completionTokens,
    total_tokens: completion.usage.totalTokens,
  });
  return { text: completion.content, usage, estimatedCostUsd, model: completion.model };
}
