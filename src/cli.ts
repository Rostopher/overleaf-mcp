#!/usr/bin/env node
// `overleaf` — CLI entry point for the non-MCP workflow.
//
// Each subcommand is a short-lived process: it joins the project's
// Socket.IO session (only when the command actually needs live doc state),
// does its work, prints JSON to stdout, and exits. Diagnostics go to stderr
// via the shared logger so stdout stays machine-parseable.
//
// Body-editing commands (edit_file / find_and_replace / accept / reject)
// are intentionally not in this first batch — for projects with the Git
// bridge enabled, plain `git push` is the better write path. The commands
// here cover the read + review-panel surface: comments, tracked-change
// listing, file reading, compile.
//
// Project selection: every project-scoped command accepts `--project <id>`.
// When omitted, the id falls back to `OL_PROJECT` env var, then to the
// persisted default set by `overleaf use <id>`.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { open as openProject, close as closeProject, docPathById, findByPath, getActiveProject } from "./session/activeProject.js";
import { joinDoc } from "./api/socket.js";
import { olGet, expectOk } from "./api/http.js";
import { updateDoc } from "./session/docCache.js";
import { fetchProjects } from "./tools/listProjects.js";
import {
  fetchThreadsEnriched,
  fetchThreadsById,
  postThreadReply,
  postThreadResolve,
} from "./tools/comments.js";
import { runCompile, fetchOutputLog, summarizeErrors } from "./tools/compile.js";
import {
  fetchAllRanges,
  flattenChanges,
  memberMap,
  postAccept,
  rejectViaOt,
  type FlatChange,
} from "./tools/trackedChanges.js";
import { logger } from "./util/logger.js";

// ---------- argv parsing (tiny hand-rolled, no dep) ----------

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags.set(name, next);
          i++;
        } else {
          flags.set(name, true);
        }
      }
    } else if (a.startsWith("-") && a.length === 2) {
      const name = a.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function flagStr(p: ParsedArgs, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = p.flags.get(n);
    if (typeof v === "string") return v;
    if (v === true) return "true";
  }
  return undefined;
}

function flagBool(p: ParsedArgs, ...names: string[]): boolean {
  return names.some((n) => p.flags.has(n));
}

// ---------- default project persistence ----------

function configFile(): string {
  const root =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? (process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"))
        : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"));
  return path.join(root, "overleaf-mcp", "cli-config.json");
}

async function loadCliConfig(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(configFile(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function saveCliConfig(cfg: Record<string, unknown>): Promise<void> {
  const file = configFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

async function resolveProjectId(p: ParsedArgs): Promise<string> {
  const fromFlag = flagStr(p, "project", "p");
  if (fromFlag) return fromFlag;
  if (process.env.OL_PROJECT) return process.env.OL_PROJECT;
  const cfg = await loadCliConfig();
  const def = cfg["default_project"];
  if (typeof def === "string" && def) return def;
  throw new Error(
    "No project specified. Pass --project <id>, set OL_PROJECT, or run `overleaf use <id>` to persist a default.",
  );
}

// ---------- output helpers ----------

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

// ---------- commands ----------

async function cmdProjects(p: ParsedArgs): Promise<void> {
  let projects = await fetchProjects();
  const totalAccount = projects.length;
  if (!flagBool(p, "archived", "include-archived")) projects = projects.filter((x) => !x.archived);
  if (!flagBool(p, "trashed", "include-trashed")) projects = projects.filter((x) => !x.trashed);
  const nameContains = flagStr(p, "name", "name-contains");
  if (nameContains) {
    const needle = nameContains.toLowerCase();
    projects = projects.filter((x) => x.name.toLowerCase().includes(needle));
  }
  const limit = Number(flagStr(p, "limit") ?? 30);
  const shown = projects.slice(0, limit);
  out({ count: shown.length, total_matched: projects.length, total_account: totalAccount, projects: shown });
}

async function cmdUse(p: ParsedArgs): Promise<void> {
  const id = p.positional[0];
  if (!id) fail("usage: overleaf use <project-id>");
  const cfg = await loadCliConfig();
  cfg["default_project"] = id;
  await saveCliConfig(cfg);
  process.stderr.write(`default project set to ${id} (saved in ${configFile()})\n`);
}

async function cmdFiles(p: ParsedArgs): Promise<void> {
  const pid = await resolveProjectId(p);
  const ap = await openProject(pid);
  try {
    const kind = flagStr(p, "kind") ?? "all";
    const needle = flagStr(p, "path", "path-contains")?.toLowerCase();
    let entities = ap.entities;
    if (kind !== "all") entities = entities.filter((e) => e.kind === kind);
    if (needle) entities = entities.filter((e) => e.path.toLowerCase().includes(needle));
    entities = [...entities].sort((a, b) => a.path.localeCompare(b.path));
    out({ project_id: pid, name: ap.name, count: entities.length, entities });
  } finally {
    closeProject();
  }
}

async function cmdRead(p: ParsedArgs): Promise<void> {
  const pid = await resolveProjectId(p);
  const ap = await openProject(pid);
  try {
    const docPath = p.positional[0] ?? flagStr(p, "path") ?? ap.rootDocPath;
    if (!docPath) fail("no path given and the project has no root doc; pass a path from `overleaf files`");
    const entity = findByPath(docPath);
    if (!entity) fail(`path not found in project: '${docPath}'`);
    if (entity.kind === "folder") fail(`'${docPath}' is a folder`);
    if (entity.kind === "doc") {
      const doc = await joinDoc(entity.id);
      const text = doc.docLines.join("\n");
      updateDoc(entity.id, text, doc.version, doc.ranges);
      const outFile = flagStr(p, "out", "o");
      if (outFile) {
        await fs.writeFile(outFile, text, "utf8");
        process.stderr.write(`wrote ${text.length} chars to ${outFile} (version ${doc.version})\n`);
      } else {
        process.stdout.write(text + "\n");
      }
      process.stderr.write(`path=${entity.path} version=${doc.version} lines=${doc.docLines.length}\n`);
      return;
    }
    // binary fileRef
    const res = await olGet(`project/${pid}/file/${entity.id}`);
    await expectOk(res, `GET project/${pid}/file/${entity.id}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const outFile = flagStr(p, "out", "o");
    if (outFile) {
      await fs.writeFile(outFile, buf);
      process.stderr.write(`wrote ${buf.length} bytes to ${outFile}\n`);
    } else {
      out({ path: entity.path, file_id: entity.id, byte_count: buf.length, base64: buf.toString("base64") });
    }
  } finally {
    closeProject();
  }
}

async function cmdComments(p: ParsedArgs): Promise<void> {
  const pid = await resolveProjectId(p);
  const ap = await openProject(pid);
  try {
    const full = flagBool(p, "full", "f");
    let threads = await fetchThreadsEnriched(pid, docPathById(ap), full);
    if (!flagBool(p, "resolved", "include-resolved")) threads = threads.filter((t) => !t.resolved);
    const needle = flagStr(p, "path", "path-contains")?.toLowerCase();
    if (needle) threads = threads.filter((t) => (t.doc_path ?? "").toLowerCase().includes(needle));
    const payload = {
      schema_version: 1,
      exported_at: new Date().toISOString(),
      project: { id: pid, name: ap.name },
      count: threads.length,
      threads,
    };
    const outFile = flagStr(p, "out", "o");
    if (outFile) {
      await fs.writeFile(outFile, JSON.stringify(payload, null, 2), "utf8");
      process.stderr.write(`wrote ${threads.length} thread(s) to ${outFile}\n`);
    } else {
      out(payload);
    }
  } finally {
    closeProject();
  }
}

async function cmdThread(p: ParsedArgs): Promise<void> {
  const pid = await resolveProjectId(p);
  const threadId = p.positional[0];
  const reply = flagStr(p, "reply");
  const resolve = flagBool(p, "resolve");
  const reopen = flagBool(p, "reopen");
  if (!threadId && !flagBool(p, "list")) {
    fail("usage: overleaf thread <thread-id> [--reply TEXT | --resolve | --reopen]");
  }
  const ap = await openProject(pid);
  try {
    if (reply !== undefined && threadId) {
      await postThreadReply(pid, threadId, reply);
      out({ ok: true, thread_id: threadId, action: "reply", content_length: reply.length });
      return;
    }
    if (resolve && threadId) {
      await postThreadResolve(pid, threadId, true);
      out({ ok: true, thread_id: threadId, action: "resolve" });
      return;
    }
    if (reopen && threadId) {
      await postThreadResolve(pid, threadId, false);
      out({ ok: true, thread_id: threadId, action: "reopen" });
      return;
    }
    // read one thread
    const all = await fetchThreadsById(pid);
    const t = all[threadId!];
    if (!t) fail(`thread '${threadId}' not found in project ${pid}`);
    out({ thread_id: threadId, ...t });
  } finally {
    closeProject();
  }
}

async function cmdChanges(p: ParsedArgs): Promise<void> {
  const pid = await resolveProjectId(p);
  const ap = await openProject(pid);
  try {
    const ranges = await fetchAllRanges(pid);
    let all = flattenChanges(ranges, docPathById(ap), memberMap(ap));
    const author = flagStr(p, "author", "author-email");
    if (author) all = all.filter((c) => c.author_email === author);
    const needle = flagStr(p, "path", "path-contains")?.toLowerCase();
    if (needle) all = all.filter((c) => (c.doc_path ?? "").toLowerCase().includes(needle));
    const kind = flagStr(p, "kind");
    if (kind && kind !== "any") all = all.filter((c) => c.kind === kind);
    const textContains = flagStr(p, "text", "text-contains")?.toLowerCase();
    if (textContains) all = all.filter((c) => c.text.toLowerCase().includes(textContains));
    all.sort((a, b) => (b.timestamp ? Date.parse(b.timestamp) : 0) - (a.timestamp ? Date.parse(a.timestamp) : 0));
    const limit = Number(flagStr(p, "limit") ?? 200);
    const fullText = flagBool(p, "full-text");
    const shown = all.slice(0, limit).map((c) => ({
      ...c,
      text: fullText ? c.text : c.text.slice(0, 200),
      text_truncated: !fullText && c.text.length > 200,
    }));
    out({ count: shown.length, total_matched: all.length, truncated: all.length > limit, changes: shown });
  } finally {
    closeProject();
  }
}

async function cmdAcceptReject(p: ParsedArgs, action: "accept" | "reject"): Promise<void> {
  const pid = await resolveProjectId(p);
  const ids = p.positional.length ? p.positional : (flagStr(p, "ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) fail(`usage: overleaf ${action} <change-id> [more-ids...]`);
  const ap = await openProject(pid);
  try {
    const ranges = await fetchAllRanges(pid);
    const pathMap = docPathById(ap);
    if (action === "accept") {
      const docByChange = new Map<string, string>();
      for (const dr of ranges) for (const c of dr.ranges?.changes ?? []) docByChange.set(c.id, dr.id);
      const grouped = new Map<string, string[]>();
      const unknown: string[] = [];
      for (const cid of ids) {
        const did = docByChange.get(cid);
        if (!did) unknown.push(cid);
        else grouped.set(did, [...(grouped.get(did) ?? []), cid]);
      }
      let accepted = 0;
      for (const [docId, docIds] of grouped) {
        await postAccept(pid, docId, docIds);
        accepted += docIds.length;
      }
      out({ ok: true, accepted, docs: grouped.size, unknown });
    } else {
      const flat = flattenChanges(ranges, pathMap, memberMap(ap));
      const wanted = new Set(ids);
      const matches = flat.filter((c) => wanted.has(c.change_id));
      const byDoc = new Map<string, FlatChange[]>();
      for (const c of matches) byDoc.set(c.doc_id, [...(byDoc.get(c.doc_id) ?? []), c]);
      let rejected = 0;
      for (const [docId, list] of byDoc) {
        await rejectViaOt(docId, list);
        rejected += list.length;
      }
      out({ ok: true, rejected, docs: byDoc.size, missing: ids.filter((i) => !wanted.has(i) || !matches.some((m) => m.change_id === i)) });
    }
  } finally {
    closeProject();
  }
}

async function cmdCompile(p: ParsedArgs): Promise<void> {
  const pid = await resolveProjectId(p);
  const ap = await openProject(pid);
  try {
    const { result, summary } = await runCompile(pid, {
      root_doc: flagStr(p, "root", "root-doc"),
      draft: flagBool(p, "draft"),
      stop_on_first_error: flagBool(p, "stop-on-first-error"),
    });
    if (flagBool(p, "log")) {
      const log = await fetchOutputLog(result);
      if (log) {
        const outFile = flagStr(p, "log-out");
        if (outFile) {
          await fs.writeFile(outFile, log, "utf8");
          process.stderr.write(`wrote log to ${outFile}\n`);
        }
        const { errors, error_count, warnings } = summarizeErrors(log);
        (summary as Record<string, unknown>).log = log;
        (summary as Record<string, unknown>).log_error_count = error_count;
        (summary as Record<string, unknown>).log_warning_count = warnings;
        (summary as Record<string, unknown>).log_errors = errors.slice(0, 20);
      }
    }
    out(summary);
  } finally {
    closeProject();
  }
}

async function cmdInfo(p: ParsedArgs): Promise<void> {
  const pid = await resolveProjectId(p);
  const ap = await openProject(pid);
  try {
    out({
      project_id: pid,
      name: ap.name,
      root_doc_path: ap.rootDocPath,
      entity_count: ap.entities.length,
      docs: ap.entities.filter((e) => e.kind === "doc").length,
      files: ap.entities.filter((e) => e.kind === "file").length,
      folders: ap.entities.filter((e) => e.kind === "folder").length,
      track_changes_on_for_me: ap.trackChangesOnForMe,
      compiler: ap.project.compiler,
      owner: ap.project.owner
        ? { email: ap.project.owner.email, name: [ap.project.owner.first_name, ap.project.owner.last_name].filter(Boolean).join(" ") || undefined }
        : undefined,
      members: (ap.project.members ?? []).map((m) => ({
        email: m.email,
        name: [m.first_name, m.last_name].filter(Boolean).join(" ") || undefined,
        privileges: m.privileges,
      })),
    });
  } finally {
    closeProject();
  }
}

// ---------- dispatch ----------

const USAGE = `overleaf — CLI for Overleaf (read + review panel; use git for body edits)

usage: overleaf <command> [options]

auth:
  login                     open Chrome to capture the session cookie
  logout --confirm          clear the stored cookie
  status                    show who you're logged in as

project selection (all project commands accept --project <id>;
                         fall back to OL_PROJECT env or \`overleaf use <id>\`):
  use <project-id>          persist a default project id
  projects [--name X] [--archived] [--trashed] [--limit N]
  info                      show the open project's metadata
  files [--kind doc|file|folder] [--path X]

docs:
  read [path] [-o file]     read a doc (default: project root doc); -o writes to file

review panel:
  comments [--resolved] [--path X] [--full] [-o out.json]
                           list comment threads; --full embeds message history
  thread <id>               read one thread's full message history
  thread <id> --reply "..." post a reply
  thread <id> --resolve     mark resolved
  thread <id> --reopen      reopen a resolved thread
  changes [--author email] [--path X] [--kind insert|delete] [--text X] [--full-text] [--limit N]
  accept <id...>            accept tracked changes (irreversible)
  reject <id...>            reject tracked changes (irreversible)

build:
  compile [--root main.tex] [--draft] [--stop-on-first-error] [--log] [--log-out f]

global flags: --project <id> / -p <id>, --out / -o <file>
env: OL_BASE_URL, OL_PROJECT, OL_BROWSER, OL_MCP_LOG_LEVEL
`;

export async function runCli(argv: string[]): Promise<number> {
  const cmd = argv[2];
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE);
    return cmd ? 0 : 1;
  }
  const p = parseArgs(argv.slice(3));
  try {
    switch (cmd) {
      case "projects": await cmdProjects(p); return 0;
      case "use": await cmdUse(p); return 0;
      case "info": await cmdInfo(p); return 0;
      case "files": await cmdFiles(p); return 0;
      case "read": await cmdRead(p); return 0;
      case "comments": await cmdComments(p); return 0;
      case "thread": await cmdThread(p); return 0;
      case "changes": await cmdChanges(p); return 0;
      case "accept": await cmdAcceptReject(p, "accept"); return 0;
      case "reject": await cmdAcceptReject(p, "reject"); return 0;
      case "compile": await cmdCompile(p); return 0;
      default:
        process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`${cmd} failed`, msg);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }
}
