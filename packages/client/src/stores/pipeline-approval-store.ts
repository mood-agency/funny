import type {
  WSPipelineApprovalRequestedData,
  WSPipelineApprovalResolvedData,
} from '@funny/shared';
import { create } from 'zustand';

import { createClientLogger } from '@/lib/client-logger';

const log = createClientLogger('pipeline-approval-store');

/** A pending approval shown in the UI. */
export interface PendingApproval extends WSPipelineApprovalRequestedData {
  /** Local-only flag set while a respond request is in flight. */
  submitting?: boolean;
  /** Local-only error from the last respond attempt. */
  submitError?: string;
}

export interface PipelineApprovalState {
  /** Active pending approvals keyed by approvalId. */
  pending: Record<string, PendingApproval>;

  handleApprovalRequested: (data: WSPipelineApprovalRequestedData) => void;
  handleApprovalResolved: (data: WSPipelineApprovalResolvedData) => void;

  /** Submit an approve/reject decision for a pending approval. */
  respond: (
    approvalId: string,
    decision: 'approve' | 'reject',
    text?: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;

  /** Hydrate from `GET /api/pipelines/approvals/pending` (e.g. on app boot). */
  loadPending: () => Promise<void>;
}

async function postRespond(
  approvalId: string,
  payload: { decision: 'approve' | 'reject'; text?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`/api/pipelines/approvals/${encodeURIComponent(approvalId)}/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload),
  });

  if (res.ok) return { ok: true };

  let error = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body?.error) error = body.error;
  } catch {
    // ignore JSON parse failures — fall back to status code
  }
  return { ok: false, error };
}

export const usePipelineApprovalStore = create<PipelineApprovalState>((set, get) => ({
  pending: {},

  handleApprovalRequested: (data) => {
    set((state) => ({
      pending: { ...state.pending, [data.approvalId]: { ...data } },
    }));
    log.info('pipeline approval requested', {
      approvalId: data.approvalId,
      gateId: data.gateId,
      threadId: data.threadId,
    });
  },

  handleApprovalResolved: (data) => {
    set((state) => {
      if (!state.pending[data.approvalId]) return state;
      const next = { ...state.pending };
      delete next[data.approvalId];
      return { pending: next };
    });
    log.info('pipeline approval resolved', {
      approvalId: data.approvalId,
      decision: data.decision,
    });
  },

  respond: async (approvalId, decision, text) => {
    set((state) => {
      const entry = state.pending[approvalId];
      if (!entry) return state;
      return {
        pending: {
          ...state.pending,
          [approvalId]: { ...entry, submitting: true, submitError: undefined },
        },
      };
    });

    const result = await postRespond(approvalId, { decision, text });

    if (result.ok) {
      // The store entry is removed by `pipeline:approval_resolved` echoed
      // from the server. Don't optimistically remove it here so that the
      // loading spinner stays visible until the round-trip completes.
      return result;
    }

    set((state) => {
      const entry = state.pending[approvalId];
      if (!entry) return state;
      return {
        pending: {
          ...state.pending,
          [approvalId]: { ...entry, submitting: false, submitError: result.error },
        },
      };
    });
    return result;
  },

  loadPending: async () => {
    try {
      const res = await fetch('/api/pipelines/approvals/pending', { credentials: 'include' });
      if (!res.ok) return;
      const body = (await res.json()) as {
        pending: Array<
          Pick<
            WSPipelineApprovalRequestedData,
            'approvalId' | 'gateId' | 'threadId' | 'requestedAt'
          >
        >;
      };
      // Don't replace the WS-driven map outright — only insert ones we don't
      // already know about. This avoids dropping fresher data that arrived
      // via WS while the HTTP request was in flight.
      const current = get().pending;
      const next = { ...current };
      for (const entry of body.pending) {
        if (!next[entry.approvalId]) {
          next[entry.approvalId] = {
            ...entry,
            message: '(loading...)',
            captureResponse: false,
          } as PendingApproval;
        }
      }
      set({ pending: next });
    } catch (err) {
      log.warn('Failed to load pending approvals', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));
