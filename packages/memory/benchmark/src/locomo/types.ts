export interface LocomoTurn {
  speaker: string;
  text: string;
  turn_number: number;
}

export interface LocomoQuestion {
  question_id: string;
  question: string;
  answer: string;
  category: LocomoCategory;
  /** Supporting evidence turns from the conversation */
  evidence_turn_numbers?: number[];
}

export type LocomoCategory =
  | 'single-hop'
  | 'multi-hop'
  | 'temporal'
  | 'open-domain'
  | 'adversarial';

export interface LocomoConversation {
  conversation_id: string;
  turns: LocomoTurn[];
  questions: LocomoQuestion[];
  /** Optional date of the conversation for temporal grounding */
  date?: string;
}

export interface LocomoDataset {
  conversations: LocomoConversation[];
  totalTurns: number;
  totalQuestions: number;
}
