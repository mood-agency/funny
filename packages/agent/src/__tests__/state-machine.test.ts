import { describe, it, expect } from 'bun:test';
import {
  StateMachine,
  TransitionError,
  PIPELINE_TRANSITIONS,
  BRANCH_TRANSITIONS,
  type BranchState,
} from '../core/state-machine.js';
import type { PipelineStatus } from '../core/types.js';

// ── StateMachine generic tests ──────────────────────────────────

describe('StateMachine', () => {
  const simpleTransitions: Record<string, string[]> = {
    idle: ['running'],
    running: ['done', 'failed'],
    done: [],
    failed: [],
  };

  it('starts in the initial state', () => {
    const sm = new StateMachine(simpleTransitions, 'idle', 'test');
    expect(sm.state).toBe('idle');
  });

  it('transition() moves to a valid state', () => {
    const sm = new StateMachine(simpleTransitions, 'idle', 'test');
    sm.transition('running');
    expect(sm.state).toBe('running');
  });

  it('transition() throws TransitionError for invalid transitions', () => {
    const sm = new StateMachine(simpleTransitions, 'idle', 'test');
    expect(() => sm.transition('done')).toThrow(TransitionError);
  });

  it('TransitionError contains from/to/label', () => {
    const sm = new StateMachine(simpleTransitions, 'idle', 'test-label');
    try {
      sm.transition('done');
    } catch (err) {
      expect(err).toBeInstanceOf(TransitionError);
      const te = err as TransitionError;
      expect(te.from).toBe('idle');
      expect(te.to).toBe('done');
      expect(te.label).toBe('test-label');
    }
  });

  it('tryTransition() returns true for valid transitions', () => {
    const sm = new StateMachine(simpleTransitions, 'idle', 'test');
    expect(sm.tryTransition('running')).toBe(true);
    expect(sm.state).toBe('running');
  });

  it('tryTransition() returns false for invalid transitions', () => {
    const sm = new StateMachine(simpleTransitions, 'idle', 'test');
    expect(sm.tryTransition('failed')).toBe(false);
    expect(sm.state).toBe('idle'); // state unchanged
  });

  it('canTransition() checks without changing state', () => {
    const sm = new StateMachine(simpleTransitions, 'idle', 'test');
    expect(sm.canTransition('running')).toBe(true);
    expect(sm.canTransition('done')).toBe(false);
    expect(sm.state).toBe('idle'); // state unchanged
  });

  it('terminal states allow no transitions', () => {
    const sm = new StateMachine(simpleTransitions, 'done', 'test');
    expect(sm.canTransition('idle')).toBe(false);
    expect(sm.canTransition('running')).toBe(false);
    expect(() => sm.transition('idle')).toThrow(TransitionError);
  });
});

// ── Pipeline status transitions ─────────────────────────────────

describe('PIPELINE_TRANSITIONS', () => {
  it('accepted → running is valid', () => {
    const sm = new StateMachine<PipelineStatus>(PIPELINE_TRANSITIONS, 'accepted', 'pipeline');
    sm.transition('running');
    expect(sm.state).toBe('running');
  });

  it('running → correcting is valid', () => {
    const sm = new StateMachine<PipelineStatus>(PIPELINE_TRANSITIONS, 'running', 'pipeline');
    sm.transition('correcting');
    expect(sm.state).toBe('correcting');
  });

  it('correcting → running is valid (re-run after fix)', () => {
    const sm = new StateMachine<PipelineStatus>(PIPELINE_TRANSITIONS, 'correcting', 'pipeline');
    sm.transition('running');
    expect(sm.state).toBe('running');
  });

  it('full correction cycle: accepted → running → correcting → running → approved', () => {
    const sm = new StateMachine<PipelineStatus>(PIPELINE_TRANSITIONS, 'accepted', 'pipeline');
    sm.transition('running');
    sm.transition('correcting');
    sm.transition('running');
    sm.transition('approved');
    expect(sm.state).toBe('approved');
  });

  it('accepted → approved is invalid (must go through running)', () => {
    const sm = new StateMachine<PipelineStatus>(PIPELINE_TRANSITIONS, 'accepted', 'pipeline');
    expect(sm.canTransition('approved')).toBe(false);
  });

  it('terminal states (approved, failed, error) allow no transitions', () => {
    for (const terminal of ['approved', 'failed', 'error'] as PipelineStatus[]) {
      const sm = new StateMachine<PipelineStatus>(PIPELINE_TRANSITIONS, terminal, 'pipeline');
      expect(sm.canTransition('accepted')).toBe(false);
      expect(sm.canTransition('running')).toBe(false);
    }
  });

  it('running → failed is valid', () => {
    const sm = new StateMachine<PipelineStatus>(PIPELINE_TRANSITIONS, 'running', 'pipeline');
    sm.transition('failed');
    expect(sm.state).toBe('failed');
  });

  it('running → error is valid', () => {
    const sm = new StateMachine<PipelineStatus>(PIPELINE_TRANSITIONS, 'running', 'pipeline');
    sm.transition('error');
    expect(sm.state).toBe('error');
  });
});

// ── Branch lifecycle transitions ────────────────────────────────

describe('BRANCH_TRANSITIONS', () => {
  it('running → ready is valid', () => {
    const sm = new StateMachine<BranchState>(BRANCH_TRANSITIONS, 'running', 'branch');
    sm.transition('ready');
    expect(sm.state).toBe('ready');
  });

  it('ready → pending_merge is valid', () => {
    const sm = new StateMachine<BranchState>(BRANCH_TRANSITIONS, 'ready', 'branch');
    sm.transition('pending_merge');
    expect(sm.state).toBe('pending_merge');
  });

  it('pending_merge → merge_history is valid', () => {
    const sm = new StateMachine<BranchState>(BRANCH_TRANSITIONS, 'pending_merge', 'branch');
    sm.transition('merge_history');
    expect(sm.state).toBe('merge_history');
  });

  it('pending_merge → pending_merge self-loop is valid (rebase)', () => {
    const sm = new StateMachine<BranchState>(BRANCH_TRANSITIONS, 'pending_merge', 'branch');
    sm.transition('pending_merge');
    expect(sm.state).toBe('pending_merge');
  });

  it('pending_merge → ready is valid (PR closed without merge)', () => {
    const sm = new StateMachine<BranchState>(BRANCH_TRANSITIONS, 'pending_merge', 'branch');
    sm.transition('ready');
    expect(sm.state).toBe('ready');
  });

  it('running → removed is valid', () => {
    const sm = new StateMachine<BranchState>(BRANCH_TRANSITIONS, 'running', 'branch');
    sm.transition('removed');
    expect(sm.state).toBe('removed');
  });

  it('merge_history and removed are terminal', () => {
    for (const terminal of ['merge_history', 'removed'] as BranchState[]) {
      const sm = new StateMachine<BranchState>(BRANCH_TRANSITIONS, terminal, 'branch');
      expect(sm.canTransition('running')).toBe(false);
      expect(sm.canTransition('ready')).toBe(false);
    }
  });
});
