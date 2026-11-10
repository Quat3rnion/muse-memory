// Shapes that the musemem CLI prints and that the service sends to the panel.

export const KINDS = ['fact', 'preference', 'commitment', 'experience', 'opinion'] as const;
export type Kind = (typeof KINDS)[number];

export const STATUSES = ['active', 'superseded', 'retracted', 'all'] as const;
export type StatusFilter = (typeof STATUSES)[number];
export type ClaimStatus = Exclude<StatusFilter, 'all'>;

export const SORTS = ['salience', 'recent', 'confidence'] as const;
export type Sort = (typeof SORTS)[number];

export interface Entity {
  name: string;
  type: string;
}

export interface Claim {
  id: string;
  text: string;
  kind: Kind;
  salience: number;
  confidence: number;
  status: ClaimStatus;
  pinned: boolean;
  supersedes_claim_id: string | null;
  superseded_by: string | null;
  quote: string | null;
  session_id: string | null;
  message_ids: string[];
  entities: Entity[];
  origin: string;
  observed_at: string | null;
  created_at: string | null;
  edited_at: string | null;
  mem0_id: string | null;
  daily_file: string | null;
  daily_citation: string | null;
}

export interface ClaimList {
  total: number;
  offset: number;
  items: Claim[];
}

export interface Evidence {
  claim_id: string;
  message_id: string;
  session_id: string;
  quote: string;
  added_at: string | null;
}

export interface SessionInfo {
  title: string | null;
  directory: string | null;
}

export interface ChainLink {
  id: string;
  text: string;
  status: ClaimStatus;
}

export interface ClaimDetail extends Claim {
  evidence: Evidence[];
  sessions: Record<string, SessionInfo>;
  supersedes_chain: ChainLink[];
}

export interface Stats {
  status: Record<string, number>;
  kind: Record<string, number>;
  origin: Record<string, number>;
  pinned: number;
  entities: Record<string, number>;
  cursor_ms: string | number | null;
  pending_forget: boolean;
  runs: Partial<Record<'consolidate' | 'dream' | 'forget', string>>;
}

export interface LegacyItem {
  id: string;
  text: string;
  created_at: string | null;
  updated_at: string | null;
  agent_id: string | null;
  metadata: Record<string, unknown>;
}

export interface LegacyList {
  total: number;
  items: LegacyItem[];
}

export interface RepairThread {
  id?: string;
  title?: string;
  status?: string;
  evidence?: string;
  next_step?: string;
  [key: string]: unknown;
}

export interface DreamsIndex {
  dates: string[];
  synthesis: string;
  companions: {
    ALIGNMENT_STATE: unknown;
    REPAIR_THREADS: unknown;
    PROGRESSION_HISTORY: unknown;
  };
}

export interface DreamFile {
  date: string;
  markdown: string;
}

export interface PinnedText {
  pinned_text: string;
}

/** Result of a command that prints plain text (note, forget). */
export interface TextResult {
  ok: true;
  message: string;
}

export interface AdoptResult {
  ok: true;
  claim_id: string | null;
  message: string;
}

export interface ErrorBody {
  error: string;
  busy?: boolean;
}
