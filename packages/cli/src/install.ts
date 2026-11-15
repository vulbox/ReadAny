import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export type InstallMode = "user" | "global";

export type InstallOptions = {
  binPath: string;
  mode?: InstallMode;
  userBinDir?: string;
  globalBinDir?: string;
  platformName?: NodeJS.Platform;
  removePathShims?: boolean;
  pathEnv?: string;
};

export type InstallResult = {
  installed: true;
  path: string;
  target: string;
  mode: InstallMode;
  /** Shim path for the standalone readany-ask command (installed alongside). */
  askPath: string;
  /** Bundle entry the readany-ask shim starts (dist/bin/readany-ask.js). */
  askTarget: string;
};

export type UninstallResult = {
  removed: boolean;
  path: string;
  mode: InstallMode;
  /** Present when the readany-ask shim existed and was removed. */
  askRemoved?: boolean;
  extraRemoved?: string[];
};

const MANAGED_SHIM_MARKER = "readany-cli-managed";

function getDefaultUserBinDir(platformName: NodeJS.Platform): string {
  if (platformName === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ReadAny", "bin");
  }

  return join(homedir(), ".local", "bin");
}

function getDefaultGlobalBinDir(platformName: NodeJS.Platform): string {
  if (platformName === "win32") {
    return join(process.env.ProgramFiles ?? "C:\\Program Files", "ReadAny", "bin");
  }

  return "/usr/local/bin";
}

export function resolveShimPath(options: InstallOptions): {
  path: string;
  mode: InstallMode;
  platformName: NodeJS.Platform;
} {
  const mode = options.mode ?? "user";
  const platformName = options.platformName ?? platform();
  const binDir =
    mode === "global"
      ? (options.globalBinDir ?? getDefaultGlobalBinDir(platformName))
      : (options.userBinDir ?? getDefaultUserBinDir(platformName));
  const commandName = platformName === "win32" ? "readany.cmd" : "readany";

  return {
    path: join(binDir, commandName),
    mode,
    platformName,
  };
}

/** Shim path for the standalone readany-ask command, beside the readany shim. */
function resolveAskShimPath(shim: {
  path: string;
  platformName: NodeJS.Platform;
}): string {
  return shim.platformName === "win32"
    ? join(dirname(shim.path), "readany-ask.cmd")
    : join(dirname(shim.path), "readany-ask");
}

/** Bundle entry the readany-ask shim starts: dist/bin/readany-ask.js. */
function resolveAskBinPath(binPath: string): string {
  return join(dirname(binPath), "readany-ask.js");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function pathsReferenceSameFile(firstPath: string, secondPath: string): Promise<boolean> {
  if (firstPath === secondPath) return true;

  try {
    return (await realpath(firstPath)) === (await realpath(secondPath));
  } catch {
    return false;
  }
}

async function targetLooksLikeReadAnyCli(targetPath: string): Promise<boolean> {
  const targetName = basename(targetPath);
  if (
    !["readany", "readany.js", "readany.ts", "readany-ask", "readany-ask.js"].includes(targetName)
  ) {
    return false;
  }
  const content = await readFile(targetPath, "utf8").catch(() => "");
  return content.includes(MANAGED_SHIM_MARKER);
}

export async function isManagedShim(shimPath: string, binPath: string): Promise<boolean> {
  if (!(await pathExists(shimPath))) return false;

  const stat = await lstat(shimPath);
  if (stat.isSymbolicLink()) {
    const target = await readlink(shimPath);
    const targetPath = isAbsolute(target) ? target : resolve(dirname(shimPath), target);
    if (await pathsReferenceSameFile(targetPath, binPath)) return true;
    if (await targetLooksLikeReadAnyCli(targetPath)) return true;
  } else {
    const content = await readFile(shimPath, "utf8").catch(() => "");
    if (content.includes(MANAGED_SHIM_MARKER)) return true;
  }

  return false;
}

async function assertManagedShim(shimPath: string, binPath: string): Promise<void> {
  if (!(await pathExists(shimPath))) return;
  if (await isManagedShim(shimPath, binPath)) return;

  const name = basename(shimPath);
  throw new Error(`${name} already exists and is not managed by ReadAny CLI: ${shimPath}`);
}

function pathShimCandidates(platformName: NodeJS.Platform, pathEnv: string): string[] {
  const commandName = platformName === "win32" ? "readany.cmd" : "readany";
  const paths = pathEnv
    .split(delimiter)
    .filter(Boolean)
    .map((path) => resolve(path, commandName));
  return [...new Set(paths)];
}

async function removeAdditionalManagedPathShims(
  primaryShimPath: string,
  options: InstallOptions,
  platformName: NodeJS.Platform,
): Promise<string[]> {
  const primary = resolve(primaryShimPath);
  const removed: string[] = [];

  for (const candidate of pathShimCandidates(platformName, options.pathEnv ?? "")) {
    if (resolve(candidate) === primary) continue;
    if (!(await pathExists(candidate))) continue;
    if (!(await isManagedShim(candidate, options.binPath))) continue;

    await rm(candidate, { force: true });
    removed.push(candidate);
  }

  return removed;
}

async function writeShim(
  shimPath: string,
  target: string,
  platformName: NodeJS.Platform,
): Promise<void> {
  await assertManagedShim(shimPath, target);
  await rm(shimPath, { force: true });

  if (platformName === "win32") {
    await writeFile(
      shimPath,
      `@echo off\r\nREM ${MANAGED_SHIM_MARKER}\r\nnode "${target}" %*\r\n`,
      "utf8",
    );
  } else {
    await symlink(target, shimPath);
    await chmod(target, 0o755).catch(() => {});
  }
}

export async function installCli(options: InstallOptions): Promise<InstallResult> {
  const shim = resolveShimPath(options);
  const askPath = resolveAskShimPath(shim);
  const askTarget = resolveAskBinPath(options.binPath);
  await mkdir(dirname(shim.path), { recursive: true });
  // Refuse before touching anything if either shim exists but is unmanaged.
  await assertManagedShim(shim.path, options.binPath);
  await assertManagedShim(askPath, askTarget);
  await writeShim(shim.path, options.binPath, shim.platformName);

  // Install the standalone readany-ask command beside readany.
  await writeShim(askPath, askTarget, shim.platformName);

  return {
    installed: true,
    path: shim.path,
    target: options.binPath,
    mode: shim.mode,
    askPath,
    askTarget,
  };
}

export async function uninstallCli(options: InstallOptions): Promise<UninstallResult> {
  const shim = resolveShimPath(options);
  let removed = false;

  if (await pathExists(shim.path)) {
    await assertManagedShim(shim.path, options.binPath);
    await rm(shim.path, { force: true });
    removed = true;
  }

  // Remove the standalone readany-ask shim installed beside readany.
  const askPath = resolveAskShimPath(shim);
  let askRemoved = false;
  if (await pathExists(askPath)) {
    await assertManagedShim(askPath, resolveAskBinPath(options.binPath));
    await rm(askPath, { force: true });
    askRemoved = true;
  }

  const extraRemoved = options.removePathShims
    ? await removeAdditionalManagedPathShims(shim.path, options, shim.platformName)
    : [];
  return {
    removed,
    path: shim.path,
    mode: shim.mode,
    ...(askRemoved ? { askRemoved } : {}),
    ...(extraRemoved.length > 0 ? { extraRemoved } : {}),
  };
}
