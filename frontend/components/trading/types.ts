export interface RuleRow { rule: string; value: unknown; source: string; meaning: string }

export interface TradingStatus {
  llm_required: boolean;
  market: { text: string | null; open: boolean | null };
  rules: RuleRow[];
  missing: string[];
  fixed: string[];
  sec_contact: { value: string | null; source: "you" | "server" | null; configured: boolean };
  pdftotext: boolean;
  tools: string[];
}
