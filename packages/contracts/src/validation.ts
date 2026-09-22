import { tradeIntentSchema, type TradeIntent } from './schemas.js';
export type IntentValidationIssue = {
  code: 'INVALID_INTENT' | 'INTENT_NOT_YET_VALID' | 'INTENT_EXPIRED'; message: string;
};
export type IntentValidationResult =
  | { success: true; data: TradeIntent }
  | { success: false; issues: IntentValidationIssue[] };

/** Shape and time-window validation with an injectable clock for deterministic tests. */
export function validateTradeIntent(input: unknown, now: Date = new Date()): IntentValidationResult {
  const parsed = tradeIntentSchema.safeParse(input);
  if (!parsed.success) return {
    success: false,
    issues: parsed.error.issues.map((issue) => ({ code: 'INVALID_INTENT', message: issue.message })),
  };
  const issuedAt = Date.parse(parsed.data.issuedAt);
  const expiresAt = Date.parse(parsed.data.expiresAt);
  const issues: IntentValidationIssue[] = [];
  if (issuedAt > now.getTime()) issues.push({ code: 'INTENT_NOT_YET_VALID', message: 'Intent issue time is in the future' });
  if (expiresAt <= now.getTime()) issues.push({ code: 'INTENT_EXPIRED', message: 'Intent has expired' });
  if (expiresAt <= issuedAt) issues.push({ code: 'INVALID_INTENT', message: 'Expiry must follow issue time' });
  return issues.length ? { success: false, issues } : { success: true, data: parsed.data };
}
