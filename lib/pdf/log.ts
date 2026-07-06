// Lightweight structured logging for each parser step of the extraction pipeline.
export function pdfLog(step: string, fields: Record<string, unknown> = {}): void {
  try {
    console.info(JSON.stringify({ event: `pdf.pipeline.${step}`, ...fields }));
  } catch {
    console.info(`pdf.pipeline.${step}`, fields);
  }
}
