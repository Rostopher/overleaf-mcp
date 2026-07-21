import type { ShareJsOp } from "./diff.js";

interface RangeChange {
  id: string;
  op: { p: number; i?: string; d?: string };
  metadata?: { user_id?: string; ts?: string };
}

export interface DocRanges {
  changes?: RangeChange[];
  comments?: unknown[];
}

export type TrackingStatus = "not_requested" | "confirmed" | "not_found" | "indeterminate";

export interface TrackingAssessment {
  status: TrackingStatus;
  changeIds: string[];
}

function changedRanges(beforeRanges: DocRanges | undefined, afterRanges: DocRanges): RangeChange[] {
  const before = new Map((beforeRanges?.changes ?? []).map((change) => [change.id, JSON.stringify(change)]));
  return (afterRanges.changes ?? []).filter((change) => before.get(change.id) !== JSON.stringify(change));
}

function sameMutationKind(change: RangeChange, op: ShareJsOp): boolean {
  return (typeof change.op.i === "string" && typeof op.i === "string") ||
    (typeof change.op.d === "string" && typeof op.d === "string");
}

function mutationText(change: RangeChange): string {
  return change.op.i ?? change.op.d ?? "";
}

function opText(op: ShareJsOp): string {
  return op.i ?? op.d ?? "";
}

function rangeContainsMutation(change: RangeChange, op: ShareJsOp): boolean {
  if (!sameMutationKind(change, op)) return false;
  const rangeText = mutationText(change);
  const submittedText = opText(op);
  if (!rangeText || !submittedText) return false;
  // Adjacent suggestions by the same user may be merged into an existing
  // range. In that case one string contains the other instead of matching
  // byte-for-byte.
  return rangeText.includes(submittedText) || submittedText.includes(rangeText);
}

export function assessTracking(opts: {
  expected: boolean;
  seed?: string;
  userId: string;
  ops: ShareJsOp[];
  beforeRanges: DocRanges | undefined;
  afterRanges: DocRanges | undefined;
}): TrackingAssessment {
  if (!opts.expected) return { status: "not_requested", changeIds: [] };
  if (!opts.afterRanges) return { status: "indeterminate", changeIds: [] };

  const allAfter = opts.afterRanges.changes ?? [];
  if (opts.seed) {
    const seeded = allAfter.filter((change) => change.id.startsWith(opts.seed!));
    if (seeded.length > 0) {
      return { status: "confirmed", changeIds: seeded.map((change) => change.id) };
    }
  }

  const mutations = opts.ops.filter((op) => Boolean(op.i || op.d));
  const candidates = changedRanges(opts.beforeRanges, opts.afterRanges)
    .filter((change) => change.metadata?.user_id === opts.userId);
  const allMutationsRecorded = mutations.length > 0 && mutations.every((op) =>
    candidates.some((change) => rangeContainsMutation(change, op)),
  );
  if (allMutationsRecorded) {
    return { status: "confirmed", changeIds: [...new Set(candidates.map((change) => change.id))] };
  }
  return { status: "not_found", changeIds: [] };
}
