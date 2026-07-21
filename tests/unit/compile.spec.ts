import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeCompileVerification, summarizeErrors } from "../../src/tools/compile.js";

describe("summarizeErrors", () => {
  it("returns zeros for an undefined log", () => {
    assert.deepEqual(summarizeErrors(undefined), { errors: [], error_count: 0, warnings: 0 });
  });

  it("returns zeros for an empty log", () => {
    assert.deepEqual(summarizeErrors(""), { errors: [], error_count: 0, warnings: 0 });
  });

  it("ignores lines that are not LaTeX errors or warnings", () => {
    const log = ["This is fine.", "Output written on main.pdf (1 page)."].join("\n");
    assert.deepEqual(summarizeErrors(log), { errors: [], error_count: 0, warnings: 0 });
  });

  it("captures `! `-prefixed error lines and trims them", () => {
    const log = ["! Undefined control sequence.", "  l.42 \\foo", "! Missing $ inserted."].join("\n");
    const result = summarizeErrors(log);
    assert.deepEqual(result.errors, ["! Undefined control sequence.", "! Missing $ inserted."]);
    assert.equal(result.error_count, 2);
    assert.equal(result.warnings, 0);
  });

  it("counts case-insensitive `warning` occurrences", () => {
    const log = [
      "LaTeX Warning: Reference `foo' undefined.",
      "Package amsmath Warning: bar baz.",
      "WARNING: shouty.",
      "no match here",
    ].join("\n");
    const result = summarizeErrors(log);
    assert.equal(result.warnings, 3);
    assert.equal(result.error_count, 0);
  });

  it("reports the true total even when errors exceed the sample size", () => {
    const log = Array.from({ length: 25 }, (_, i) => `! Error number ${i}.`).join("\n");
    const result = summarizeErrors(log);
    assert.equal(result.error_count, 25, "error_count must be the full total");
    assert.equal(result.errors.length, 20, "errors must be sampled to the default cap of 20");
    assert.equal(result.errors[0], "! Error number 0.");
    assert.equal(result.errors[19], "! Error number 19.");
  });

  it("honors a custom maxErrorLines cap", () => {
    const log = Array.from({ length: 250 }, (_, i) => `! e${i}`).join("\n");
    const result = summarizeErrors(log, 200);
    assert.equal(result.error_count, 250);
    assert.equal(result.errors.length, 200);
  });

  it("does not double-count: a line matching both `! ` and `warning` is bucketed as error", () => {
    // The implementation tests `! ` first via if/else, so this can't be a warning too.
    const log = "! warning-shaped error line";
    const result = summarizeErrors(log);
    assert.equal(result.error_count, 1);
    assert.equal(result.warnings, 0);
  });
});

describe("computeCompileVerification", () => {
  it("reports clean only when a PDF and parsed log are both available with zero errors", () => {
    assert.deepEqual(
      computeCompileVerification({ pdfAvailable: true, logAvailable: true, errorCount: 0 }),
      { built_cleanly: true, verification_complete: true },
    );
  });

  it("fails closed when output.log could not be fetched", () => {
    assert.deepEqual(
      computeCompileVerification({ pdfAvailable: true, logAvailable: false, errorCount: 0 }),
      { built_cleanly: false, verification_complete: false },
    );
  });

  it("reports a verified dirty build when the log contains errors", () => {
    assert.deepEqual(
      computeCompileVerification({ pdfAvailable: true, logAvailable: true, errorCount: 2 }),
      { built_cleanly: false, verification_complete: true },
    );
  });
});
