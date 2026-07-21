import { chmod } from "node:fs/promises";

// Windows launches npm bins through generated .cmd shims and has no POSIX
// executable bit. Unix-like platforms still benefit from marking the emitted
// shebang entrypoint executable for direct source-tree use.
if (process.platform !== "win32") {
  await chmod(new URL("../dist/index.js", import.meta.url), 0o755);
}
