import type {
  WSPipelineApprovalRequestedData,
  WSPipelineApprovalResolvedData,
} from '@funny/shared';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { usePipelineApprovalStore } from '@/stores/pipeline-approval-store';

function makeRequested(
  overrides: Partial<WSPipelineApprovalRequestedData> = {},
): WSPipelineApprovalRequestedData {
  return {
    approvalId: 'a-1',
    gateId: 'confirm',
    message: 'Push feature/x?',
    captureResponse: false,
    threadId: 't-1',
    requestedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('usePipelineApprovalStore', () => {
  beforeEach(() => {
    usePipelineApprovalStore.setState({ pending: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('handleApprovalRequested adds the approval to the queue', () => {
    usePipelineApprovalStore.getState().handleApprovalRequested(makeRequested());
    expect(usePipelineApprovalStore.getState().pending['a-1']).toMatchObject({
      gateId: 'confirm',
      message: 'Push feature/x?',
    });
  });

  test('handleApprovalResolved removes the approval from the queue', () => {
    usePipelineApprovalStore.getState().handleApprovalRequested(makeRequested());
    const resolved: WSPipelineApprovalResolvedData = {
      approvalId: 'a-1',
      gateId: 'confirm',
      threadId: 't-1',
      decision: 'approve',
    };
    usePipelineApprovalStore.getState().handleApprovalResolved(resolved);
    expect(usePipelineApprovalStore.getState().pending['a-1']).toBeUndefined();
  });

  test('handleApprovalResolved is a no-op when the approval is unknown', () => {
    const before = usePipelineApprovalStore.getState().pending;
    usePipelineApprovalStore.getState().handleApprovalResolved({
      approvalId: 'unknown',
      gateId: 'x',
      threadId: 't',
      decision: 'reject',
    });
    expect(usePipelineApprovalStore.getState().pending).toBe(before);
  });

  test('respond sets submitting=true while in flight, leaves cleanup to the WS event', async () => {
    usePipelineApprovalStore.getState().handleApprovalRequested(makeRequested());

    let resolveFetch: (v: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );

    const promise = usePipelineApprovalStore.getState().respond('a-1', 'approve', 'lgtm');

    // While in flight, submitting flag is set.
    await Promise.resolve(); // let the set() in respond run
    expect(usePipelineApprovalStore.getState().pending['a-1']?.submitting).toBe(true);

    resolveFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await promise;
    expect(result).toEqual({ ok: true });

    // The entry stays in the store until WS resolves it (intentional —
    // see comment in respond()).
    expect(usePipelineApprovalStore.getState().pending['a-1']).toBeDefined();
  });

  test('respond surfaces server errors as submitError', async () => {
    usePipelineApprovalStore.getState().handleApprovalRequested(makeRequested());
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ error: 'Approval not found' }), { status: 404 }),
      ),
    );

    const result = await usePipelineApprovalStore.getState().respond('a-1', 'approve');
    expect(result).toEqual({ ok: false, error: 'Approval not found' });
    const entry = usePipelineApprovalStore.getState().pending['a-1'];
    expect(entry?.submitting).toBe(false);
    expect(entry?.submitError).toBe('Approval not found');
  });

  test('respond is a no-op when the approval is unknown', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await usePipelineApprovalStore.getState().respond('unknown', 'approve');
    // fetch is still called (route returns 404), but no store mutation occurs.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(Object.keys(usePipelineApprovalStore.getState().pending)).toHaveLength(0);
  });
});
