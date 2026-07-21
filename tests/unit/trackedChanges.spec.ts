import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildRejectOps, type FlatChange } from "../../src/tools/trackedChanges.js";
import { generateIdSeed, resolveTracking } from "../../src/ot/trackedChanges.js";

function change(overrides: Partial<FlatChange>): FlatChange {
  return {
    change_id: "change-id",
    doc_id: "doc-id",
    kind: "insert",
    position: 0,
    text: "x",
    ...overrides,
  };
}

describe("tracked-change helpers", () => {
  it("generates an 18-character hexadecimal tc seed", () => {
    assert.match(generateIdSeed(), /^[0-9a-f]{18}$/);
  });

  it("reports when the server setting overrides track:off", () => {
    assert.deepEqual(resolveTracking("off", true), {
      shouldTrack: false,
      trackingExpected: true,
      trackOverridden: true,
    });
  });

  it("builds inverse undo ops in descending position order", () => {
    const ops = buildRejectOps([
      change({ change_id: "insert", kind: "insert", position: 2, text: "added" }),
      change({ change_id: "delete", kind: "delete", position: 10, text: "removed" }),
    ]);
    assert.deepEqual(ops, [
      { p: 10, i: "removed", u: true },
      { p: 2, d: "added", u: true },
    ]);
  });
});
