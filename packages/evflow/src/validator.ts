import type {
  EventModelData,
  ValidationIssue,
  AutomationDef,
  ReadModelDef,
  ElementKind,
} from './types.js';

/**
 * Validate an EventModel for consistency issues.
 * Returns all issues found (both errors and warnings).
 */
export function validate(model: EventModelData): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  checkReadModelSources(model, issues);
  checkAutomationReferences(model, issues);
  checkSequenceReferences(model, issues);
  checkSliceReferences(model, issues);
  checkOrphanElements(model, issues);
  checkDuplicateSequenceNames(model, issues);

  // Semantic checks
  checkEmptySequences(model, issues);
  checkSequenceOrdering(model, issues);
  checkDeadEvents(model, issues);
  checkAutomationCycles(model, issues);

  return issues;
}

/** ReadModel.from must reference existing events */
function checkReadModelSources(model: EventModelData, issues: ValidationIssue[]): void {
  for (const el of model.elements.values()) {
    if (el.kind !== 'readModel') continue;
    const rm = el as ReadModelDef;
    for (const source of rm.from) {
      const ref = model.elements.get(source);
      if (!ref) {
        issues.push({
          severity: 'error',
          code: 'READ_MODEL_UNKNOWN_SOURCE',
          message: `ReadModel "${rm.name}" references unknown event "${source}" in 'from'`,
          source: rm.name,
        });
      } else if (ref.kind !== 'event') {
        issues.push({
          severity: 'error',
          code: 'READ_MODEL_INVALID_SOURCE',
          message: `ReadModel "${rm.name}" references "${source}" which is a ${ref.kind}, not an event`,
          source: rm.name,
        });
      }
    }
  }
}

/** Automation.on must reference an event, automation.triggers must reference a command */
function checkAutomationReferences(model: EventModelData, issues: ValidationIssue[]): void {
  for (const el of model.elements.values()) {
    if (el.kind !== 'automation') continue;
    const auto = el as AutomationDef;

    // Check 'on' event
    const onRef = model.elements.get(auto.on);
    if (!onRef) {
      issues.push({
        severity: 'error',
        code: 'AUTOMATION_UNKNOWN_EVENT',
        message: `Automation "${auto.name}" listens to unknown event "${auto.on}"`,
        source: auto.name,
      });
    } else if (onRef.kind !== 'event') {
      issues.push({
        severity: 'error',
        code: 'AUTOMATION_INVALID_EVENT',
        message: `Automation "${auto.name}" listens to "${auto.on}" which is a ${onRef.kind}, not an event`,
        source: auto.name,
      });
    }

    // Check 'triggers' command(s)
    const triggers = Array.isArray(auto.triggers) ? auto.triggers : [auto.triggers];
    for (const t of triggers) {
      const tRef = model.elements.get(t);
      if (!tRef) {
        issues.push({
          severity: 'error',
          code: 'AUTOMATION_UNKNOWN_COMMAND',
          message: `Automation "${auto.name}" triggers unknown command "${t}"`,
          source: auto.name,
        });
      } else if (tRef.kind !== 'command') {
        issues.push({
          severity: 'warning',
          code: 'AUTOMATION_TRIGGERS_NON_COMMAND',
          message: `Automation "${auto.name}" triggers "${t}" which is a ${tRef.kind}, not a command`,
          source: auto.name,
        });
      }
    }
  }
}

/** Every name in a sequence must be a defined element */
function checkSequenceReferences(model: EventModelData, issues: ValidationIssue[]): void {
  for (const seq of model.sequences) {
    for (const step of seq.steps) {
      if (!model.elements.has(step)) {
        issues.push({
          severity: 'error',
          code: 'SEQUENCE_UNKNOWN_ELEMENT',
          message: `Sequence "${seq.name}" references unknown element "${step}"`,
          source: seq.name,
        });
      }
    }
  }
}

/** Every name in a slice must be a defined element */
function checkSliceReferences(model: EventModelData, issues: ValidationIssue[]): void {
  for (const slice of model.slices) {
    const allRefs = [...slice.commands, ...slice.events, ...slice.readModels, ...slice.automations];
    for (const ref of allRefs) {
      if (!model.elements.has(ref)) {
        issues.push({
          severity: 'error',
          code: 'SLICE_UNKNOWN_ELEMENT',
          message: `Slice "${slice.name}" references unknown element "${ref}"`,
          source: slice.name,
        });
      }
    }
  }
}

/** Warn about elements that never appear in any sequence */
function checkOrphanElements(model: EventModelData, issues: ValidationIssue[]): void {
  if (model.sequences.length === 0) return;

  const referenced = new Set<string>();
  for (const seq of model.sequences) {
    for (const step of seq.steps) {
      referenced.add(step);
    }
  }

  for (const el of model.elements.values()) {
    if (el.kind === 'readModel' || el.kind === 'automation') continue;
    if (!referenced.has(el.name)) {
      issues.push({
        severity: 'warning',
        code: el.kind === 'event' ? 'ORPHAN_EVENT' : 'ORPHAN_COMMAND',
        message: `${el.kind} "${el.name}" is defined but never appears in any sequence`,
        source: el.name,
      });
    }
  }
}

/** Warn about duplicate sequence names */
function checkDuplicateSequenceNames(model: EventModelData, issues: ValidationIssue[]): void {
  const seen = new Set<string>();
  for (const seq of model.sequences) {
    if (seen.has(seq.name)) {
      issues.push({
        severity: 'warning',
        code: 'DUPLICATE_SEQUENCE_NAME',
        message: `Duplicate sequence name "${seq.name}"`,
        source: seq.name,
      });
    }
    seen.add(seq.name);
  }
}

// ── Semantic Checks ──────────────────────────────────────────

/** Warn about sequences with fewer than 2 steps */
function checkEmptySequences(model: EventModelData, issues: ValidationIssue[]): void {
  for (const seq of model.sequences) {
    if (seq.steps.length < 2) {
      issues.push({
        severity: 'warning',
        code: 'EMPTY_SEQUENCE',
        message: `Sequence "${seq.name}" has ${seq.steps.length} step(s) — needs at least 2 to express a temporal flow`,
        source: seq.name,
      });
    }
  }
}

/** Valid element kind transitions in sequences per Event Modeling semantics */
const VALID_TRANSITIONS: Record<ElementKind, Set<ElementKind>> = {
  command: new Set(['event']),
  event: new Set(['command', 'readModel', 'event']),
  readModel: new Set(['command']),
  automation: new Set([]),
};

/** Warn about invalid kind→kind transitions in sequences */
function checkSequenceOrdering(model: EventModelData, issues: ValidationIssue[]): void {
  for (const seq of model.sequences) {
    for (let i = 0; i < seq.steps.length - 1; i++) {
      const fromEl = model.elements.get(seq.steps[i]);
      const toEl = model.elements.get(seq.steps[i + 1]);

      // Skip pairs where either element is unknown (handled by SEQUENCE_UNKNOWN_ELEMENT)
      if (!fromEl || !toEl) continue;

      const allowed = VALID_TRANSITIONS[fromEl.kind];
      if (!allowed || !allowed.has(toEl.kind)) {
        issues.push({
          severity: 'warning',
          code: 'SEQUENCE_INVALID_TRANSITION',
          message: `Sequence "${seq.name}": invalid transition ${fromEl.kind} "${fromEl.name}" → ${toEl.kind} "${toEl.name}"`,
          source: seq.name,
        });
      }
    }
  }
}

/** Warn about events not consumed by any ReadModel or Automation */
function checkDeadEvents(model: EventModelData, issues: ValidationIssue[]): void {
  const hasReadModels = [...model.elements.values()].some((e) => e.kind === 'readModel');
  const hasAutomations = [...model.elements.values()].some((e) => e.kind === 'automation');

  // Skip if model has no consumers at all (partial model)
  if (!hasReadModels && !hasAutomations) return;

  const consumed = new Set<string>();

  for (const el of model.elements.values()) {
    if (el.kind === 'readModel') {
      for (const source of (el as ReadModelDef).from) {
        consumed.add(source);
      }
    }
    if (el.kind === 'automation') {
      consumed.add((el as AutomationDef).on);
    }
  }

  for (const el of model.elements.values()) {
    if (el.kind !== 'event') continue;
    if (!consumed.has(el.name)) {
      issues.push({
        severity: 'warning',
        code: 'EVENT_WITHOUT_CONSUMER',
        message: `Event "${el.name}" is not consumed by any ReadModel or Automation`,
        source: el.name,
      });
    }
  }
}

/** Detect circular automation chains via DFS on inferred causality graph */
function checkAutomationCycles(model: EventModelData, issues: ValidationIssue[]): void {
  if (model.sequences.length === 0) return;

  // Build causality graph:
  // command → event (inferred from sequences: consecutive command followed by event)
  // event → command (explicit from automations)
  const graph = new Map<string, Set<string>>();

  const addEdge = (from: string, to: string) => {
    let neighbors = graph.get(from);
    if (!neighbors) {
      neighbors = new Set();
      graph.set(from, neighbors);
    }
    neighbors.add(to);
  };

  // Infer command→event edges from sequences
  for (const seq of model.sequences) {
    for (let i = 0; i < seq.steps.length - 1; i++) {
      const fromEl = model.elements.get(seq.steps[i]);
      const toEl = model.elements.get(seq.steps[i + 1]);
      if (fromEl?.kind === 'command' && toEl?.kind === 'event') {
        addEdge(fromEl.name, toEl.name);
      }
    }
  }

  // Extract event→command edges from automations
  for (const el of model.elements.values()) {
    if (el.kind !== 'automation') continue;
    const auto = el as AutomationDef;
    const triggers = Array.isArray(auto.triggers) ? auto.triggers : [auto.triggers];
    for (const t of triggers) {
      if (model.elements.get(t)?.kind === 'command') {
        addEdge(auto.on, t);
      }
    }
  }

  // DFS cycle detection with path tracking
  const WHITE = 0; // unvisited
  const GRAY = 1; // in current path
  const BLACK = 2; // fully explored
  const color = new Map<string, number>();
  const parent = new Map<string, string>();
  const reported = new Set<string>();

  function dfs(node: string): string[] | null {
    color.set(node, GRAY);
    const neighbors = graph.get(node);
    if (neighbors) {
      for (const next of neighbors) {
        const nextColor = color.get(next) ?? WHITE;
        if (nextColor === GRAY) {
          // Found a cycle — reconstruct path
          const path = [next];
          let cur = node;
          while (cur !== next) {
            path.push(cur);
            cur = parent.get(cur)!;
          }
          path.push(next);
          path.reverse();
          return path;
        }
        if (nextColor === WHITE) {
          parent.set(next, node);
          const cycle = dfs(next);
          if (cycle) return cycle;
        }
      }
    }
    color.set(node, BLACK);
    return null;
  }

  for (const node of graph.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const cycle = dfs(node);
      if (cycle) {
        // Normalize: use the lexically smallest node as start to avoid duplicate reports
        const key = [...cycle.slice(0, -1)].sort().join(',');
        if (!reported.has(key)) {
          reported.add(key);
          issues.push({
            severity: 'warning',
            code: 'AUTOMATION_CYCLE',
            message: `Automation cycle detected: ${cycle.join(' -> ')}`,
          });
        }
      }
    }
  }
}
