import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { enrichThreads } from "../../src/tools/comments.js";
import type { RangesResponse, ThreadsByIdResponse } from "../../src/api/commentTypes.js";

const threads: ThreadsByIdResponse = {
  thread123: {
    messages: [
      {
        id: "message1",
        content: "Please clarify this sentence.",
        timestamp: 100,
        user: { first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" },
      },
      {
        id: "message2",
        content: "I agree.",
        timestamp: 200,
      },
    ],
  },
};

const ranges: RangesResponse = [
  {
    id: "doc1",
    ranges: {
      comments: [{ id: "comment1", op: { p: 12, c: "quoted sentence", t: "thread123" } }],
    },
  },
];

describe("enrichThreads", () => {
  it("omits full message history in compact mode", () => {
    const result = enrichThreads(threads, ranges, new Map([["doc1", "main.tex"]]), false);
    assert.equal(result.length, 1);
    assert.equal(result[0].doc_path, "main.tex");
    assert.equal(result[0].quoted_text, "quoted sentence");
    assert.equal(result[0].preview, "I agree.");
    assert.equal(result[0].full_thread, undefined);
  });

  it("includes full message history when full=true", () => {
    const result = enrichThreads(threads, ranges, new Map([["doc1", "main.tex"]]), true);
    assert.deepEqual(result[0].full_thread, threads.thread123);
    assert.equal(result[0].full_thread?.messages.length, 2);
  });
});
