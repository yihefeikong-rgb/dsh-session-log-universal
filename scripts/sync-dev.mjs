#!/usr/bin/env node
/**
 * Sync this repository into the copy DSH actually loads.
 *
 * The loader imports `<DSH_HOME>/node_modules/dsh-session-log-universal`, while
 * the only place the code is edited is this checkout. This script makes the
 * runtime copy match the checkout: it writes `package.json` and every top-level
 * `lib/*.js` file, and nothing else.
 *
 * Properties the copy relies on:
 * - Idempotent: a file whose bytes already match is not touched, so a repeat run
 *   is a no-op and an editor's file watcher is not woken for nothing.
 * - Narrow: no other path in the runtime copy is created, written or removed.
 *   The single exception is a stale `lib/*.js` file that no longer exists in the
 *   checkout, which is deleted so the loader cannot import abandoned code.
 * - Verifiable: `--check` reports drift without writing, `--dry-run` prints the
 *   plan, and both exit non-zero when the runtime copy is not up to date.
 *
 * Usage:
 *   node scripts/sync-dev.mjs                  copy into the default runtime copy
 *   node scripts/sync-dev.mjs --dry-run        print the plan, write nothing
 *   node scripts/sync-dev.mjs --check          exit 1 when out of sync
 *   node scripts/sync-dev.mjs --target <dir>   copy into an explicit directory
 *   DSH_RUNTIME_DIR=<dir> node scripts/sync-dev.mjs
 *
 * The default target is `<DSH_HOME>/node_modules/dsh-session-log-universal`,
 * where `DSH_HOME` follows the harness convention and defaults to `~/.dsh`.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package directory of this checkout: the script lives in `<repo>/scripts`. */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** Package name; also the directory name inside the runtime `node_modules`. */
const PACKAGE_NAME = "dsh-session-log-universal";
/** Files always copied, relative to the package root. */
const ROOT_FILES = ["package.json", "cordis.patch.yml"];
/** Directories whose top-level `.js` files are copied, relative to the package root. */
const SCRIPT_DIRECTORIES = ["lib"];

/**
 * Parse the command line.
 * @param argv - arguments after the script name.
 * @returns the parsed options.
 * @throws {Error} when an option or its value is malformed.
 */
function parseArguments(argv) {
  const options = { target: undefined, dryRun: false, check: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--check") options.check = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--target") {
      const value = argv[++index];
      if (value === undefined || value.length === 0) throw new Error("--target needs a directory");
      options.target = value;
    } else {
      throw new Error(
        "unknown argument: " + String(argument) +
        " (supported: --dry-run, --check, --target <dir>, --help)",
      );
    }
  }
  return options;
}

/**
 * Resolve the runtime copy the harness loads.
 * @param explicit - the `--target` value, when given.
 * @returns the absolute package directory.
 */
function resolveTarget(explicit) {
  if (explicit !== undefined) return explicit;
  if (process.env.DSH_RUNTIME_DIR) return process.env.DSH_RUNTIME_DIR;
  const home = process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), ".dsh");
  return join(home, "node_modules", PACKAGE_NAME);
}

/**
 * List the files this sync owns, relative to a package root.
 * @param packageRoot - directory to list `lib/*.js` from; absent directories contribute nothing.
 * @returns package-relative paths, sorted.
 */
function ownedFiles(packageRoot) {
  const files = [...ROOT_FILES];
  for (const directory of SCRIPT_DIRECTORIES) {
    const absolute = join(packageRoot, directory);
    if (!existsSync(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".js")) files.push(directory + "/" + entry.name);
    }
  }
  return files.sort();
}

/**
 * Decide what one file needs.
 * @param sourcePath - file in this checkout.
 * @param targetPath - matching file in the runtime copy.
 * @returns "create", "update" or "unchanged".
 */
function outcomeOf(sourcePath, targetPath) {
  if (!existsSync(targetPath)) return "create";
  const source = readFileSync(sourcePath);
  const target = readFileSync(targetPath);
  return source.equals(target) ? "unchanged" : "update";
}

/**
 * Copy one file, creating its directory when the runtime copy lacks it.
 * @param sourcePath - file in this checkout.
 * @param targetPath - destination in the runtime copy.
 */
function copyFile(sourcePath, targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
}

/** Render the usage banner taken from this file's own header comment. */
function usage() {
  const text = readFileSync(fileURLToPath(import.meta.url), "utf8");
  return text.slice(0, text.indexOf("*/") + 2);
}

/** Entry point: plan, then apply unless the run is read-only. */
function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + "\n");
    return 0;
  }

  const target = resolveTarget(options.target);
  process.stdout.write("repo:    " + REPO_ROOT + "\n");
  process.stdout.write("runtime: " + target + "\n\n");

  if (!existsSync(target)) {
    process.stderr.write("sync-dev: runtime copy not found: " + target + "\n");
    process.stderr.write("sync-dev: install the plugin for this DSH home first (see README), or pass --target <dir>.\n");
    return 1;
  }

  const sources = ownedFiles(REPO_ROOT);
  const stale = ownedFiles(target).filter(function (relativePath) {
    return sources.indexOf(relativePath) === -1;
  });
  const readOnly = options.dryRun || options.check;
  const counts = { create: 0, update: 0, unchanged: 0, remove: 0 };

  for (const relativePath of sources) {
    const sourcePath = join(REPO_ROOT, relativePath);
    const targetPath = join(target, relativePath);
    const outcome = outcomeOf(sourcePath, targetPath);
    counts[outcome]++;
    const bytes = String(readFileSync(sourcePath).length) + " bytes";
    let verb = outcome;
    if (readOnly && outcome !== "unchanged") verb = options.check ? "drifted" : "pending";
    process.stdout.write("  " + verb.padEnd(9) + " " + relativePath.padEnd(20) + " " + bytes + "\n");
    if (!readOnly && outcome !== "unchanged") copyFile(sourcePath, targetPath);
  }

  // A stale file is abandoned code the loader could still import by path.
  for (const relativePath of stale) {
    counts.remove++;
    const verb = readOnly && options.check ? "drifted" : "remove";
    process.stdout.write("  " + verb.padEnd(9) + " " + relativePath.padEnd(20) + " not in this checkout\n");
    if (!readOnly) rmSync(join(target, relativePath), { force: true });
  }

  const pending = counts.create + counts.update + counts.remove;
  process.stdout.write("\n" + String(counts.unchanged) + " unchanged, " + String(counts.create) + " created, " +
    String(counts.update) + " updated, " + String(counts.remove) + " removed\n");
  if (pending === 0) {
    process.stdout.write("runtime copy is up to date\n");
    return 0;
  }
  if (options.check) {
    process.stderr.write("sync-dev: runtime copy is out of date; run `npm run sync`\n");
    return 1;
  }
  if (options.dryRun) {
    process.stdout.write(String(pending) + " file(s) would change; nothing was written (--dry-run)\n");
    return 0;
  }
  process.stdout.write(String(pending) + " file(s) synced\n");
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write("sync-dev: " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
