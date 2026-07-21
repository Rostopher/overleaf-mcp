import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assessTracking } from "../../src/ot/trackingVerification.js";

describe("assessTracking", () => {
  const userId = "user-1";
  const seed = "abcdef0123456789ab";
  const ops = [{ p: 5, i: "new text" }];

  it("returns not_requested when the server is not expected to track", () => {
    assert.deepEqual(
      assessTracking({ expected: false, seed, userId, ops, beforeRanges: undefined, afterRanges: undefined }),
      { status: "not_requested", changeIds: [] },
    );
  });

  it("confirms a server change id derived from the submitted tc seed", () => {
    const result = assessTracking({
      expected: true,
      seed,
      userId,
      ops,
      beforeRanges: { changes: [] },
      afterRanges: {
        changes: [{ id: `${seed}000001`, op: { p: 5, i: "new text" }, metadata: { user_id: userId } }],
      },
    });
    assert.deepEqual(result, { status: "confirmed", changeIds: [`${seed}000001`] });
  });

  it("confirms an edit merged into an existing same-user tracked range", () => {
    const result = assessTracking({
      expected: true,
      seed,
      userId,
      ops,
      beforeRanges: {
        changes: [{ id: "existing", op: { p: 5, i: "new " }, metadata: { user_id: userId } }],
      },
      afterRanges: {
        changes: [{ id: "existing", op: { p: 5, i: "new text" }, metadata: { user_id: userId } }],
      },
    });
    assert.deepEqual(result, { status: "confirmed", changeIds: ["existing"] });
  });

  it("returns not_found when the text landed without a matching tracked range", () => {
    const result = assessTracking({
      expected: true,
      seed,
      userId,
      ops,
      beforeRanges: { changes: [] },
      afterRanges: { changes: [] },
    });
    assert.deepEqual(result, { status: "not_found", changeIds: [] });
  });

  it("returns indeterminate when post-edit ranges are unavailable", () => {
    const result = assessTracking({
      expected: true,
      seed,
      userId,
      ops,
      beforeRanges: { changes: [] },
      afterRanges: undefined,
    });
    assert.deepEqual(result, { status: "indeterminate", changeIds: [] });
  });
});
