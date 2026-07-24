// Pure model-capability + token/cost ESTIMATION helpers. Prices are approximate
// (USD per 1M tokens) and used only for benchmark cost estimates — the live API
// returns exact usage. No document content is handled here.

export const DEFAULT_OCR_MODEL = "gpt-4o-mini";

type Pricing = { inputPerM: number; outputPerM: number };

// Approximate public pricing (USD / 1M tokens). Update as pricing changes.
const PRICING: Record<string, Pricing> = {
  "gpt-4o-mini": { inputPerM: 0.15, outputPerM: 0.6 },
  "gpt-4o": { inputPerM: 2.5, outputPerM: 10 },
  "gpt-4.1": { inputPerM: 2.0, outputPerM: 8 },
  "gpt-4.1-mini": { inputPerM: 0.4, outputPerM: 1.6 },
};

export function pricingFor(model: string): Pricing {
  return PRICING[model] ?? PRICING[DEFAULT_OCR_MODEL];
}

// Vision-capable model families. Text-only models must not be used for the
// scanned/image path.
export function modelSupportsVision(model: string): boolean {
  return /^(gpt-4o|gpt-4\.1|gpt-4-turbo|o1|o3|gpt-5)/i.test(model.trim());
}

// Structured-output (json_schema / json_object) support.
export function modelSupportsStructuredOutput(model: string): boolean {
  return /^(gpt-4o|gpt-4\.1|gpt-4-turbo|o1|o3|gpt-5|gpt-3\.5)/i.test(model.trim());
}

// Rough token estimate for text: ~4 characters per token.
export function estimateTextTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

// Rough token estimate for a single image at OpenAI "high" detail: an 85-token
// base plus 170 tokens per 512px tile. "low" detail is a flat 85 tokens.
export function estimateImageTokens(
  widthPx: number,
  heightPx: number,
  detail: "low" | "high" = "high",
): number {
  if (detail === "low") return 85;
  const tilesW = Math.max(1, Math.ceil(widthPx / 512));
  const tilesH = Math.max(1, Math.ceil(heightPx / 512));
  return 85 + 170 * tilesW * tilesH;
}

export function estimateCostUsd(input: { model: string; inputTokens: number; outputTokens: number }): number {
  const pricing = pricingFor(input.model);
  const cost = (input.inputTokens / 1_000_000) * pricing.inputPerM + (input.outputTokens / 1_000_000) * pricing.outputPerM;
  // Round to 6 decimals (fractions of a cent).
  return Math.round(cost * 1_000_000) / 1_000_000;
}
