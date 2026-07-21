import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildOtUpdate } from "../../src/api/socket.js";

describe("buildOtUpdate", () => {
  it("omits meta for a direct edit", () => {
    assert.deepEqual(buildOtUpdate("doc-id", [{ p: 3, i: "text" }], 12), {
      doc: "doc-id",
      op: [{ p: 3, i: "text" }],
      v: 12,
    });
  });

  it("sends only the tc seed for a tracked edit", () => {
    assert.deepEqual(buildOtUpdate("doc-id", [{ p: 3, d: "text" }], 12, "seed"), {
      doc: "doc-id",
      op: [{ p: 3, d: "text" }],
      v: 12,
      meta: { tc: "seed" },
    });
  });
});
