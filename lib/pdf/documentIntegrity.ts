/**
 * Document integrity indicators for a PDF.
 *
 * The instruction this is built against:
 *
 *   "Do NOT copy competitor-style '89.5% Authenticity' scoring unless the
 *    underlying score has a defensible statistical meaning."
 *
 * There is no such meaning available here, so there is no score. A single
 * percentage would have to combine incommensurable observations — a digital
 * signature, an incremental save, a producer string — into one number, and the
 * weights would be invented. Worse, the number would be believed: "89.5%
 * authentic" reads as a measurement of authenticity when it is a weighted guess
 * about file structure.
 *
 * So this reports OBSERVATIONS, each of which is a checkable fact about the
 * bytes, and each of which carries what it does and does not mean. Several have
 * entirely innocent explanations, and the honest ones say so — a bank statement
 * downloaded and re-saved by a mail client shows incremental updates and has
 * been altered by nobody.
 *
 * These are integrity indicators, not fraud findings. The distinction is the
 * whole point: a fraud finding accuses someone, and nothing observable in a PDF
 * container can support that on its own.
 */

export type IntegrityObservation = {
  id: string;
  label: string;
  /** What was actually found, in plain terms. */
  finding: string;
  /** True when this is worth a human looking, NOT when it is evidence of fraud. */
  notable: boolean;
  /** Why it might be innocent. Present whenever notable is true. */
  benignExplanation?: string;
};

export type DocumentIntegrity = {
  observations: IntegrityObservation[];
  /** Count of observations flagged notable. Deliberately not a score. */
  notableCount: number;
  /** One line for a reader, never a percentage. */
  assessment: string;
};

const DECODER = new TextDecoder("latin1");

function readAsText(bytes: Uint8Array): string {
  // latin1 keeps byte values intact for structural markers, which is all this
  // inspects. It is not attempting to read document content.
  return DECODER.decode(bytes);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function extractField(text: string, field: string): string | null {
  // Matches /Field (value) — the common literal-string form. Hex strings and
  // stream-held XMP metadata are not read, and nothing is inferred from their
  // absence.
  const match = new RegExp(`/${field}\\s*\\(([^)]{0,200})\\)`).exec(text);
  return match ? match[1].trim() || null : null;
}

/**
 * Inspect a PDF's structure.
 *
 * Deliberately limited to what the container states about itself. Nothing here
 * renders pages, compares fonts glyph by glyph, or looks at pixels — claims of
 * that kind would need evidence this function does not have, and inventing them
 * is exactly the failure mode the brief warns about.
 */
export function inspectDocumentIntegrity(bytes: Uint8Array): DocumentIntegrity {
  const text = readAsText(bytes);
  const observations: IntegrityObservation[] = [];

  // 1. Digital signature. Its ABSENCE is not suspicious — almost no bank
  //    statement is signed — so this is reported and never flagged.
  const signed = /\/ByteRange\s*\[/.test(text) || /\/Type\s*\/Sig\b/.test(text);
  observations.push({
    id: "digital_signature",
    label: "Digital signature",
    finding: signed ? "Present" : "Not detected",
    notable: false,
  });

  // 2. Incremental updates. A PDF written once ends with a single %%EOF. Each
  //    later save appends another. This is the most informative structural
  //    signal available, and also one of the most innocently triggered.
  const eofCount = countOccurrences(text, "%%EOF");
  const incrementalUpdates = Math.max(0, eofCount - 1);
  observations.push({
    id: "incremental_updates",
    label: "Incremental saves after creation",
    finding: incrementalUpdates === 0 ? "None" : `${incrementalUpdates}`,
    notable: incrementalUpdates > 0,
    benignExplanation:
      incrementalUpdates > 0
        ? "Opening and re-saving a PDF in a viewer, adding an annotation, or downloading through some mail clients all append a save. This does not indicate the content was changed."
        : undefined,
  });

  // 3. Modification date later than creation date. Same caveat.
  const created = extractField(text, "CreationDate");
  const modified = extractField(text, "ModDate");
  const datesDiffer = Boolean(created && modified && created !== modified);
  observations.push({
    id: "metadata_dates",
    label: "Modification date",
    finding: !modified ? "Not recorded" : datesDiffer ? `Differs from creation (${created ?? "unknown"} → ${modified})` : "Matches creation",
    notable: datesDiffer,
    benignExplanation: datesDiffer
      ? "A viewer that re-saves a file updates this date without altering the content."
      : undefined,
  });

  // 4. Producing software. Reported as context, never judged — this function
  //    has no basis for calling one producer more trustworthy than another,
  //    and a list of "suspicious" tools would be a guess dressed as a check.
  const producer = extractField(text, "Producer");
  const creator = extractField(text, "Creator");
  observations.push({
    id: "producer",
    label: "Producing software",
    finding: [creator, producer].filter(Boolean).join(" / ") || "Not recorded",
    notable: false,
  });

  // 5. Encryption. Statements are often password-protected by the bank, so this
  //    is reported for context rather than flagged.
  const encrypted = /\/Encrypt\s+\d+\s+\d+\s+R/.test(text.slice(-16_384)) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(text);
  observations.push({
    id: "encryption",
    label: "Encryption",
    finding: encrypted ? "Declared" : "None declared",
    notable: false,
  });

  const notableCount = observations.filter((observation) => observation.notable).length;

  return {
    observations,
    notableCount,
    // A sentence, not a percentage, and it recommends looking rather than
    // concluding.
    assessment:
      notableCount === 0
        ? "No structural integrity indicators were found. This is not a statement about the document's content."
        : `${notableCount} structural indicator${notableCount === 1 ? "" : "s"} worth a manual look. These are not findings of fraud, and each has common innocent causes.`,
  };
}
