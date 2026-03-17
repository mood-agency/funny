import { describe, test, expect } from 'bun:test';

import type { EventModelData, ElementDef } from '../types.js';
import { validate } from '../validator.js';

function model(
  elements: Record<string, ElementDef>,
  sequences: EventModelData['sequences'] = [],
  slices: EventModelData['slices'] = [],
): EventModelData {
  return {
    name: 'Test',
    elements: new Map(Object.entries(elements)),
    sequences,
    slices,
  };
}

describe('validate', () => {
  test('returns no issues for a valid model', () => {
    const m = model(
      {
        AddItem: { kind: 'command', name: 'AddItem', fields: { id: 'string' } },
        ItemAdded: { kind: 'event', name: 'ItemAdded', fields: { id: 'string' } },
        CartView: {
          kind: 'readModel',
          name: 'CartView',
          from: ['ItemAdded'],
          fields: { id: 'string' },
        },
        AutoAdd: { kind: 'automation', name: 'AutoAdd', on: 'ItemAdded', triggers: 'AddItem' },
      },
      [{ name: 'Flow', steps: ['AddItem', 'ItemAdded'] }],
    );
    const issues = validate(m);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  test('detects READ_MODEL_UNKNOWN_SOURCE', () => {
    const m = model({
      CartView: { kind: 'readModel', name: 'CartView', from: ['NonExistent'], fields: {} },
    });
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'READ_MODEL_UNKNOWN_SOURCE', severity: 'error' }),
    );
  });

  test('detects READ_MODEL_INVALID_SOURCE when source is not an event', () => {
    const m = model({
      AddItem: { kind: 'command', name: 'AddItem', fields: {} },
      CartView: { kind: 'readModel', name: 'CartView', from: ['AddItem'], fields: {} },
    });
    const issues = validate(m);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'READ_MODEL_INVALID_SOURCE' }));
  });

  test('detects AUTOMATION_UNKNOWN_EVENT', () => {
    const m = model({
      DoSomething: { kind: 'command', name: 'DoSomething', fields: {} },
      Auto: { kind: 'automation', name: 'Auto', on: 'GhostEvent', triggers: 'DoSomething' },
    });
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'AUTOMATION_UNKNOWN_EVENT', severity: 'error' }),
    );
  });

  test('detects AUTOMATION_UNKNOWN_COMMAND', () => {
    const m = model({
      SomeEvent: { kind: 'event', name: 'SomeEvent', fields: {} },
      Auto: { kind: 'automation', name: 'Auto', on: 'SomeEvent', triggers: 'GhostCommand' },
    });
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'AUTOMATION_UNKNOWN_COMMAND', severity: 'error' }),
    );
  });

  test('detects AUTOMATION_INVALID_EVENT when on is not an event', () => {
    const m = model({
      Cmd: { kind: 'command', name: 'Cmd', fields: {} },
      Auto: { kind: 'automation', name: 'Auto', on: 'Cmd', triggers: 'Cmd' },
    });
    const issues = validate(m);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'AUTOMATION_INVALID_EVENT' }));
  });

  test('detects SEQUENCE_UNKNOWN_ELEMENT', () => {
    const m = model({ A: { kind: 'command', name: 'A', fields: {} } }, [
      { name: 'Flow', steps: ['A', 'B'] },
    ]);
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'SEQUENCE_UNKNOWN_ELEMENT', severity: 'error' }),
    );
  });

  test('detects SLICE_UNKNOWN_ELEMENT', () => {
    const m = model(
      { A: { kind: 'command', name: 'A', fields: {} } },
      [],
      [
        {
          name: 'Slice',
          ui: 'Page',
          commands: ['A'],
          events: ['Nope'],
          readModels: [],
          automations: [],
        },
      ],
    );
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'SLICE_UNKNOWN_ELEMENT', severity: 'error' }),
    );
  });

  test('warns on ORPHAN_EVENT', () => {
    const m = model(
      {
        Cmd: { kind: 'command', name: 'Cmd', fields: {} },
        Evt: { kind: 'event', name: 'Evt', fields: {} },
      },
      [{ name: 'Flow', steps: ['Cmd'] }], // Evt not in any sequence
    );
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'ORPHAN_EVENT', severity: 'warning' }),
    );
  });

  test('warns on ORPHAN_COMMAND', () => {
    const m = model(
      {
        Cmd: { kind: 'command', name: 'Cmd', fields: {} },
        Evt: { kind: 'event', name: 'Evt', fields: {} },
      },
      [{ name: 'Flow', steps: ['Evt'] }], // Cmd not in any sequence
    );
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'ORPHAN_COMMAND', severity: 'warning' }),
    );
  });

  test('does not warn about orphans when no sequences exist', () => {
    const m = model({
      Cmd: { kind: 'command', name: 'Cmd', fields: {} },
      Evt: { kind: 'event', name: 'Evt', fields: {} },
    });
    const issues = validate(m);
    const orphans = issues.filter((i) => i.code === 'ORPHAN_EVENT' || i.code === 'ORPHAN_COMMAND');
    expect(orphans).toHaveLength(0);
  });

  test('warns on DUPLICATE_SEQUENCE_NAME', () => {
    const m = model({ A: { kind: 'command', name: 'A', fields: {} } }, [
      { name: 'Same', steps: ['A'] },
      { name: 'Same', steps: ['A'] },
    ]);
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'DUPLICATE_SEQUENCE_NAME', severity: 'warning' }),
    );
  });

  test('validates automation with multiple triggers', () => {
    const m = model({
      Evt: { kind: 'event', name: 'Evt', fields: {} },
      Cmd1: { kind: 'command', name: 'Cmd1', fields: {} },
      Auto: { kind: 'automation', name: 'Auto', on: 'Evt', triggers: ['Cmd1', 'GhostCmd'] },
    });
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'AUTOMATION_UNKNOWN_COMMAND',
        message: expect.stringContaining('GhostCmd'),
      }),
    );
  });
});

// ── Semantic Validation ────────────────────────────────────────

describe('checkEmptySequences', () => {
  test('warns on sequence with zero steps', () => {
    const m = model({ A: { kind: 'command', name: 'A', fields: {} } }, [
      { name: 'Empty', steps: [] },
    ]);
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'EMPTY_SEQUENCE', severity: 'warning' }),
    );
  });

  test('warns on sequence with one step', () => {
    const m = model({ A: { kind: 'command', name: 'A', fields: {} } }, [
      { name: 'Single', steps: ['A'] },
    ]);
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'EMPTY_SEQUENCE', severity: 'warning' }),
    );
  });

  test('does not warn on sequence with two or more steps', () => {
    const m = model(
      {
        A: { kind: 'command', name: 'A', fields: {} },
        B: { kind: 'event', name: 'B', fields: {} },
      },
      [{ name: 'Valid', steps: ['A', 'B'] }],
    );
    const issues = validate(m);
    const empty = issues.filter((i) => i.code === 'EMPTY_SEQUENCE');
    expect(empty).toHaveLength(0);
  });
});

describe('checkSequenceOrdering', () => {
  // Invalid transitions
  test('warns on command → command (missing event)', () => {
    const m = model(
      {
        Cmd1: { kind: 'command', name: 'Cmd1', fields: {} },
        Cmd2: { kind: 'command', name: 'Cmd2', fields: {} },
      },
      [{ name: 'Flow', steps: ['Cmd1', 'Cmd2'] }],
    );
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'SEQUENCE_INVALID_TRANSITION', severity: 'warning' }),
    );
  });

  test('warns on readModel → event', () => {
    const m = model(
      {
        Evt: { kind: 'event', name: 'Evt', fields: {} },
        RM: { kind: 'readModel', name: 'RM', from: ['Evt'], fields: {} },
      },
      [{ name: 'Flow', steps: ['RM', 'Evt'] }],
    );
    const issues = validate(m);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'SEQUENCE_INVALID_TRANSITION' }));
  });

  test('warns on readModel → readModel', () => {
    const m = model(
      {
        Evt: { kind: 'event', name: 'Evt', fields: {} },
        RM1: { kind: 'readModel', name: 'RM1', from: ['Evt'], fields: {} },
        RM2: { kind: 'readModel', name: 'RM2', from: ['Evt'], fields: {} },
      },
      [{ name: 'Flow', steps: ['RM1', 'RM2'] }],
    );
    const issues = validate(m);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'SEQUENCE_INVALID_TRANSITION' }));
  });

  test('warns on command → readModel (missing event)', () => {
    const m = model(
      {
        Cmd: { kind: 'command', name: 'Cmd', fields: {} },
        Evt: { kind: 'event', name: 'Evt', fields: {} },
        RM: { kind: 'readModel', name: 'RM', from: ['Evt'], fields: {} },
      },
      [{ name: 'Flow', steps: ['Cmd', 'RM'] }],
    );
    const issues = validate(m);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'SEQUENCE_INVALID_TRANSITION' }));
  });

  // Valid transitions
  test('allows command → event', () => {
    const m = model(
      {
        Cmd: { kind: 'command', name: 'Cmd', fields: {} },
        Evt: { kind: 'event', name: 'Evt', fields: {} },
      },
      [{ name: 'Flow', steps: ['Cmd', 'Evt'] }],
    );
    const issues = validate(m);
    const ordering = issues.filter((i) => i.code === 'SEQUENCE_INVALID_TRANSITION');
    expect(ordering).toHaveLength(0);
  });

  test('allows event → command', () => {
    const m = model(
      {
        Evt: { kind: 'event', name: 'Evt', fields: {} },
        Cmd: { kind: 'command', name: 'Cmd', fields: {} },
      },
      [{ name: 'Flow', steps: ['Evt', 'Cmd'] }],
    );
    const issues = validate(m);
    const ordering = issues.filter((i) => i.code === 'SEQUENCE_INVALID_TRANSITION');
    expect(ordering).toHaveLength(0);
  });

  test('allows event → readModel', () => {
    const m = model(
      {
        Evt: { kind: 'event', name: 'Evt', fields: {} },
        RM: { kind: 'readModel', name: 'RM', from: ['Evt'], fields: {} },
      },
      [{ name: 'Flow', steps: ['Evt', 'RM'] }],
    );
    const issues = validate(m);
    const ordering = issues.filter((i) => i.code === 'SEQUENCE_INVALID_TRANSITION');
    expect(ordering).toHaveLength(0);
  });

  test('allows event → event', () => {
    const m = model(
      {
        Evt1: { kind: 'event', name: 'Evt1', fields: {} },
        Evt2: { kind: 'event', name: 'Evt2', fields: {} },
      },
      [{ name: 'Flow', steps: ['Evt1', 'Evt2'] }],
    );
    const issues = validate(m);
    const ordering = issues.filter((i) => i.code === 'SEQUENCE_INVALID_TRANSITION');
    expect(ordering).toHaveLength(0);
  });

  test('allows readModel → command', () => {
    const m = model(
      {
        Evt: { kind: 'event', name: 'Evt', fields: {} },
        RM: { kind: 'readModel', name: 'RM', from: ['Evt'], fields: {} },
        Cmd: { kind: 'command', name: 'Cmd', fields: {} },
      },
      [{ name: 'Flow', steps: ['RM', 'Cmd'] }],
    );
    const issues = validate(m);
    const ordering = issues.filter((i) => i.code === 'SEQUENCE_INVALID_TRANSITION');
    expect(ordering).toHaveLength(0);
  });

  test('skips pairs with unknown elements', () => {
    const m = model({ Cmd: { kind: 'command', name: 'Cmd', fields: {} } }, [
      { name: 'Flow', steps: ['Cmd', 'Unknown', 'Cmd'] },
    ]);
    const issues = validate(m);
    const ordering = issues.filter((i) => i.code === 'SEQUENCE_INVALID_TRANSITION');
    expect(ordering).toHaveLength(0);
  });

  test('valid full sequence command → event → readModel produces no warnings', () => {
    const m = model(
      {
        AddItem: { kind: 'command', name: 'AddItem', fields: {} },
        ItemAdded: { kind: 'event', name: 'ItemAdded', fields: {} },
        CartView: { kind: 'readModel', name: 'CartView', from: ['ItemAdded'], fields: {} },
      },
      [{ name: 'Flow', steps: ['AddItem', 'ItemAdded', 'CartView'] }],
    );
    const issues = validate(m);
    const ordering = issues.filter((i) => i.code === 'SEQUENCE_INVALID_TRANSITION');
    expect(ordering).toHaveLength(0);
  });
});

describe('checkDeadEvents', () => {
  test('no warning when event is consumed by ReadModel only', () => {
    const m = model({
      Evt: { kind: 'event', name: 'Evt', fields: {} },
      RM: { kind: 'readModel', name: 'RM', from: ['Evt'], fields: {} },
    });
    const issues = validate(m);
    const dead = issues.filter((i) => i.code === 'EVENT_WITHOUT_CONSUMER');
    expect(dead).toHaveLength(0);
  });

  test('no warning when event is listened to by Automation only', () => {
    const m = model({
      Evt: { kind: 'event', name: 'Evt', fields: {} },
      Cmd: { kind: 'command', name: 'Cmd', fields: {} },
      Auto: { kind: 'automation', name: 'Auto', on: 'Evt', triggers: 'Cmd' },
    });
    const issues = validate(m);
    const dead = issues.filter((i) => i.code === 'EVENT_WITHOUT_CONSUMER');
    expect(dead).toHaveLength(0);
  });

  test('warns on event with no consumers', () => {
    const m = model({
      Evt: { kind: 'event', name: 'Evt', fields: {} },
      OtherEvt: { kind: 'event', name: 'OtherEvt', fields: {} },
      Cmd: { kind: 'command', name: 'Cmd', fields: {} },
      Auto: { kind: 'automation', name: 'Auto', on: 'OtherEvt', triggers: 'Cmd' },
    });
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'EVENT_WITHOUT_CONSUMER',
        severity: 'warning',
        source: 'Evt',
      }),
    );
  });

  test('skips dead event check when model has no ReadModels and no Automations', () => {
    const m = model({
      Evt: { kind: 'event', name: 'Evt', fields: {} },
      Cmd: { kind: 'command', name: 'Cmd', fields: {} },
    });
    const issues = validate(m);
    const dead = issues.filter((i) => i.code === 'EVENT_WITHOUT_CONSUMER');
    expect(dead).toHaveLength(0);
  });
});

describe('checkAutomationCycles', () => {
  test('detects simple two-node cycle', () => {
    const m = model(
      {
        PlaceOrder: { kind: 'command', name: 'PlaceOrder', fields: {} },
        OrderPlaced: { kind: 'event', name: 'OrderPlaced', fields: {} },
        Auto: { kind: 'automation', name: 'Auto', on: 'OrderPlaced', triggers: 'PlaceOrder' },
      },
      [{ name: 'Flow', steps: ['PlaceOrder', 'OrderPlaced'] }],
    );
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'AUTOMATION_CYCLE', severity: 'warning' }),
    );
    const cycle = issues.find((i) => i.code === 'AUTOMATION_CYCLE');
    expect(cycle?.message).toContain('PlaceOrder');
    expect(cycle?.message).toContain('OrderPlaced');
  });

  test('detects multi-node cycle', () => {
    const m = model(
      {
        A: { kind: 'command', name: 'A', fields: {} },
        EvtA: { kind: 'event', name: 'EvtA', fields: {} },
        B: { kind: 'command', name: 'B', fields: {} },
        EvtB: { kind: 'event', name: 'EvtB', fields: {} },
        Auto1: { kind: 'automation', name: 'Auto1', on: 'EvtA', triggers: 'B' },
        Auto2: { kind: 'automation', name: 'Auto2', on: 'EvtB', triggers: 'A' },
      },
      [
        { name: 'Flow1', steps: ['A', 'EvtA'] },
        { name: 'Flow2', steps: ['B', 'EvtB'] },
      ],
    );
    const issues = validate(m);
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'AUTOMATION_CYCLE', severity: 'warning' }),
    );
  });

  test('no warning when automations form a DAG', () => {
    const m = model(
      {
        A: { kind: 'command', name: 'A', fields: {} },
        EvtA: { kind: 'event', name: 'EvtA', fields: {} },
        B: { kind: 'command', name: 'B', fields: {} },
        EvtB: { kind: 'event', name: 'EvtB', fields: {} },
        Auto1: { kind: 'automation', name: 'Auto1', on: 'EvtA', triggers: 'B' },
      },
      [
        { name: 'Flow1', steps: ['A', 'EvtA'] },
        { name: 'Flow2', steps: ['B', 'EvtB'] },
      ],
    );
    const issues = validate(m);
    const cycles = issues.filter((i) => i.code === 'AUTOMATION_CYCLE');
    expect(cycles).toHaveLength(0);
  });

  test('skips cycle detection when no sequences exist', () => {
    const m = model({
      Evt: { kind: 'event', name: 'Evt', fields: {} },
      Cmd: { kind: 'command', name: 'Cmd', fields: {} },
      Auto: { kind: 'automation', name: 'Auto', on: 'Evt', triggers: 'Cmd' },
    });
    const issues = validate(m);
    const cycles = issues.filter((i) => i.code === 'AUTOMATION_CYCLE');
    expect(cycles).toHaveLength(0);
  });
});
