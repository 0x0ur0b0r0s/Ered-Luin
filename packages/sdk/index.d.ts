/** A source observation for public examples and hosted-service integrations. */
export interface EvidenceRecord {
  id: string;
  source: string;
  observedAt: string;
  freshness: "fresh" | "stale" | "unknown";
  attributes: Record<string, string | number | boolean | null>;
}

/** A provenance-bearing group of observations. */
export interface EvidencePacket {
  version: "1";
  id: string;
  createdAt: string;
  synthetic?: boolean;
  evidence: EvidenceRecord[];
}

/** An advisory statement linked back to evidence; it grants no authority. */
export interface IntelligenceFinding {
  id: string;
  statement: string;
  evidenceIds: string[];
}

/** A public schema for summaries that remain advisory. */
export interface IntelligencePacket {
  version: "1";
  id: string;
  createdAt: string;
  sourcePacketId: string;
  advisoryOnly: true;
  summary: string;
  findings: IntelligenceFinding[];
}