export type MerchantKnowledgeEntry = {
  canonicalName: string;
  aliases: string[];
  defaultCategory: string;
  defaultVatTreatment: "standard" | "zero_rated" | "exempt" | "out_of_scope" | "review";
};

export const BASE_MERCHANT_KNOWLEDGE: MerchantKnowledgeEntry[] = [
  { canonicalName: "Uber Eats", aliases: ["uber eats"], defaultCategory: "Staff Welfare / Meals / Entertainment", defaultVatTreatment: "review" },
  { canonicalName: "Uber", aliases: ["uber"], defaultCategory: "Motor Vehicle Expenses", defaultVatTreatment: "standard" },
  { canonicalName: "Google", aliases: ["google", "google cloud"], defaultCategory: "Software / IT", defaultVatTreatment: "standard" },
  { canonicalName: "Microsoft", aliases: ["microsoft", "office365"], defaultCategory: "Software / IT", defaultVatTreatment: "standard" },
  { canonicalName: "Amazon", aliases: ["amazon", "aws"], defaultCategory: "Software / IT", defaultVatTreatment: "standard" },
  { canonicalName: "Takealot", aliases: ["takealot"], defaultCategory: "Uncategorised Expense", defaultVatTreatment: "standard" },
  { canonicalName: "SARS", aliases: ["sars"], defaultCategory: "Levies", defaultVatTreatment: "out_of_scope" },
  { canonicalName: "Eskom", aliases: ["eskom"], defaultCategory: "Utilities", defaultVatTreatment: "standard" },
  { canonicalName: "Discovery", aliases: ["discovery"], defaultCategory: "Insurance", defaultVatTreatment: "exempt" },
  { canonicalName: "DHL", aliases: ["dhl", "paygate dhl"], defaultCategory: "Courier / Delivery", defaultVatTreatment: "standard" },
  { canonicalName: "ChatGPT", aliases: ["chatgpt", "openai"], defaultCategory: "Software Subscriptions", defaultVatTreatment: "standard" },
  { canonicalName: "Checkers", aliases: ["checkers"], defaultCategory: "Staff Welfare / Meals / Entertainment", defaultVatTreatment: "review" },
  { canonicalName: "Woolworths", aliases: ["woolworths"], defaultCategory: "Staff Welfare / Meals / Entertainment", defaultVatTreatment: "review" },
  { canonicalName: "Clicks", aliases: ["clicks"], defaultCategory: "Staff Welfare / Meals / Entertainment", defaultVatTreatment: "review" },
  { canonicalName: "Dis-Chem", aliases: ["dis chem", "dis-chem"], defaultCategory: "Staff Welfare / Meals / Entertainment", defaultVatTreatment: "review" },
];
