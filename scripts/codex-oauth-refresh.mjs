import { createHash } from "node:crypto";
import fsSync, { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const REFRESH_TIMEOUT_MS = 120_000;
const FILE_LOCK_TIMEOUT_ERROR_CODE = "file_lock_timeout";
const AUTH_STORE_LOCK_OPTIONS = {
  retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
  stale: 30_000,
};
const OAUTH_REFRESH_LOCK_OPTIONS = {
  retries: { retries: 20, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
  stale: 180_000,
};

const HELD_LOCKS = new Map();

function resolveUserPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function openClawStateDir() {
  return process.env.OPENCLAW_STATE_DIR?.trim()
    ? resolveUserPath(process.env.OPENCLAW_STATE_DIR.trim())
    : path.join(os.homedir(), ".openclaw");
}

function openClawRefreshLockPath(provider, profileId) {
  const hash = createHash("sha256");
  hash.update(provider, "utf8");
  hash.update("\u0000", "utf8");
  hash.update(profileId, "utf8");
  return path.join(openClawStateDir(), "locks", "oauth-refresh", `sha256-${hash.digest("hex")}`);
}

function releaseAllLocksSync() {
  for (const [normalizedFile, held] of HELD_LOCKS) {
    void held.handle.close().catch(() => undefined);
    try {
      fsSync.rmSync(held.lockPath, { force: true });
    } catch {
      // Best-effort process-exit cleanup only.
    }
    HELD_LOCKS.delete(normalizedFile);
  }
}

process.once("exit", releaseAllLocksSync);

function computeDelayMs(retries, attempt) {
  const base = Math.min(
    retries.maxTimeout,
    Math.max(retries.minTimeout, retries.minTimeout * retries.factor ** attempt)
  );
  const jitter = retries.randomize ? 1 + Math.random() : 1;
  return Math.min(retries.maxTimeout, Math.round(base * jitter));
}

async function readLockPayload(lockPath) {
  try {
    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8"));
    if (typeof parsed.pid !== "number" || typeof parsed.createdAt !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function normalizeFilePath(filePath) {
  const resolved = path.resolve(filePath);
  const directory = path.dirname(resolved);
  await fs.mkdir(directory, { recursive: true });
  try {
    return path.join(await fs.realpath(directory), path.basename(resolved));
  } catch {
    return resolved;
  }
}

async function isStaleLock(lockPath, staleMs) {
  const payload = await readLockPayload(lockPath);
  if (payload?.pid && !isPidAlive(payload.pid)) return true;
  if (payload?.createdAt) {
    const createdAt = Date.parse(payload.createdAt);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleMs) return true;
  }
  try {
    return Date.now() - (await fs.stat(lockPath)).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

async function releaseHeldLock(normalizedFile) {
  const current = HELD_LOCKS.get(normalizedFile);
  if (!current) return;
  current.count -= 1;
  if (current.count > 0) return;
  HELD_LOCKS.delete(normalizedFile);
  await current.handle.close().catch(() => undefined);
  await fs.rm(current.lockPath, { force: true }).catch(() => undefined);
}

async function acquireFileLock(filePath, options) {
  const normalizedFile = await normalizeFilePath(filePath);
  const lockPath = `${normalizedFile}.lock`;
  const held = HELD_LOCKS.get(normalizedFile);
  if (held) {
    held.count += 1;
    return { release: () => releaseHeldLock(normalizedFile) };
  }

  for (let attempt = 0; attempt <= options.retries.retries; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
      HELD_LOCKS.set(normalizedFile, { count: 1, handle, lockPath });
      return { release: () => releaseHeldLock(normalizedFile) };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await isStaleLock(lockPath, options.stale)) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
        continue;
      }
      if (attempt >= options.retries.retries) break;
      await new Promise((resolve) => setTimeout(resolve, computeDelayMs(options.retries, attempt)));
    }
  }

  throw Object.assign(new Error(`Timed out waiting for OAuth lock: ${lockPath}`), {
    code: FILE_LOCK_TIMEOUT_ERROR_CODE,
    lockPath,
  });
}

async function withFileLock(filePath, options, fn) {
  const lock = await acquireFileLock(filePath, options);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

function accessToken(profile) {
  return profile?.access ?? profile?.access_token ?? profile?.token ?? null;
}

function refreshToken(profile) {
  return profile?.refresh ?? profile?.refresh_token ?? null;
}

function accountId(profile) {
  return profile?.accountId ?? profile?.account_id ?? profile?.account ?? null;
}

function normalizedExpiry(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value < 1e12 ? value * 1000 : value;
}

function selectedCredential(store, format, profileId) {
  if (format === "codex-auth-json") {
    return {
      accessToken: store?.tokens?.access_token ?? null,
      refreshToken: store?.tokens?.refresh_token ?? null,
      accountId: store?.tokens?.account_id ?? null,
      email: null,
      expiresMs: null,
    };
  }
  if (format === "openclaw-auth-profiles") {
    const profile = store?.profiles?.[profileId];
    return {
      accessToken: accessToken(profile),
      refreshToken: refreshToken(profile),
      accountId: accountId(profile),
      email: profile?.email ?? null,
      expiresMs: normalizedExpiry(profile?.expires),
    };
  }
  const provider = profileId?.includes(":") ? profileId.split(":")[0] : "openai-codex";
  const profile = store?.[provider];
  return {
    accessToken: accessToken(profile),
    refreshToken: refreshToken(profile),
    accountId: accountId(profile),
    email: profile?.email ?? null,
    expiresMs: normalizedExpiry(profile?.expires),
  };
}

function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return payload?.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function credentialIsFresh(credential) {
  const expiresMs = credential.expiresMs ?? jwtExpiryMs(credential.accessToken ?? "");
  return expiresMs ? expiresMs > Date.now() : false;
}

function normalizedIdentity(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function credentialsHaveCompatibleIdentity(left, right) {
  const leftAccount = normalizedIdentity(left.accountId);
  const rightAccount = normalizedIdentity(right.accountId);
  if (leftAccount && rightAccount) return leftAccount === rightAccount;
  const leftEmail = normalizedIdentity(left.email);
  const rightEmail = normalizedIdentity(right.email);
  if (leftEmail && rightEmail) return leftEmail === rightEmail;
  return !leftAccount && !leftEmail;
}

function refreshedExpiresMs(response) {
  if (typeof response.expires_at === "number") return response.expires_at < 1e12 ? response.expires_at * 1000 : response.expires_at;
  if (typeof response.expires_in === "number") return Date.now() + response.expires_in * 1000;
  return jwtExpiryMs(response.access_token ?? "");
}

function mergeRefreshResponse(store, format, profileId, response) {
  const next = structuredClone(store);
  if (format === "codex-auth-json") {
    next.tokens ??= {};
    if (response.access_token) next.tokens.access_token = response.access_token;
    if (response.refresh_token) next.tokens.refresh_token = response.refresh_token;
    if (response.id_token) next.tokens.id_token = response.id_token;
    next.last_refresh = new Date().toISOString();
    return next;
  }

  const provider = profileId?.includes(":") ? profileId.split(":")[0] : "openai-codex";
  const profile = format === "openclaw-auth-profiles" ? next.profiles?.[profileId] : next[provider];
  if (!profile) throw new Error(`OAuth profile disappeared during refresh: ${profileId ?? provider}`);
  if (response.access_token) profile.access = response.access_token;
  if (response.refresh_token) profile.refresh = response.refresh_token;
  if (response.id_token) profile.idToken = response.id_token;
  const expires = refreshedExpiresMs(response);
  if (expires) profile.expires = expires;
  return next;
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (process.platform !== "win32" || !["EACCES", "EEXIST", "EPERM"].includes(error?.code)) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
  }
  try {
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function safeRefreshFailure(status, text) {
  try {
    const parsed = JSON.parse(text);
    const code = typeof parsed.error === "string" ? parsed.error : parsed?.error?.code ?? parsed?.code;
    return `OAuth refresh failed: HTTP ${status}${code ? ` (${code})` : ""}`;
  } catch {
    return `OAuth refresh failed: HTTP ${status}`;
  }
}

async function requestRefresh({ refreshUrl, token, userAgent }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const response = await fetch(refreshUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        originator: "codex_cli_rs",
        "user-agent": userAgent,
      },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: token,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      let oauthCode = null;
      try {
        const parsed = JSON.parse(text);
        oauthCode = typeof parsed.error === "string" ? parsed.error : parsed?.error?.code ?? parsed?.code ?? null;
      } catch {
        // The safe message still reports the HTTP status for non-JSON responses.
      }
      throw Object.assign(new Error(safeRefreshFailure(response.status, text)), {
        status: response.status,
        oauthCode,
      });
    }
    return JSON.parse(text);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`OAuth refresh timed out after ${REFRESH_TIMEOUT_MS / 1000} seconds`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function mainOpenClawAuthPath() {
  return path.join(openClawStateDir(), "agents", "main", "agent", "auth-profiles.json");
}

async function adoptFreshMainOpenClawProfile(options, currentStore) {
  if (options.format !== "openclaw-auth-profiles" || !options.profileId) return null;
  const mainPath = mainOpenClawAuthPath();
  if (path.resolve(mainPath) === path.resolve(options.authPath)) return null;

  let mainStore;
  try {
    mainStore = JSON.parse(await fs.readFile(mainPath, "utf8"));
  } catch {
    return null;
  }

  const current = selectedCredential(currentStore, options.format, options.profileId);
  const main = selectedCredential(mainStore, options.format, options.profileId);
  if (!main.accessToken || !credentialIsFresh(main)) return null;
  if (!credentialsHaveCompatibleIdentity(current, main)) return null;
  if (main.accessToken === current.accessToken && main.refreshToken === current.refreshToken) return null;

  const mainProfile = mainStore.profiles?.[options.profileId];
  if (!mainProfile || !currentStore.profiles?.[options.profileId]) return null;
  const nextStore = structuredClone(currentStore);
  nextStore.profiles[options.profileId] = structuredClone(mainProfile);
  await writeJsonAtomic(options.authPath, nextStore);
  return { refreshed: false, skipped: "inherited fresh main OpenClaw auth" };
}

async function refreshUnderStoreLock(options) {
  const store = JSON.parse(await fs.readFile(options.authPath, "utf8"));
  const current = selectedCredential(store, options.format, options.profileId);
  if (!current.refreshToken) throw new Error(`No refresh token is available in ${options.authPath}`);

  if (current.refreshToken !== options.originalRefreshToken || current.accessToken !== options.originalAccessToken) {
    return { refreshed: false, skipped: "auth changed" };
  }
  const inherited = await adoptFreshMainOpenClawProfile(options, store);
  if (inherited) return inherited;
  if (options.reason !== "HTTP authentication failure" && credentialIsFresh(current)) {
    return { refreshed: false, skipped: "already fresh" };
  }

  let response;
  try {
    response = await requestRefresh({
      refreshUrl: options.refreshUrl,
      token: current.refreshToken,
      userAgent: options.userAgent,
    });
  } catch (error) {
    const latestStore = JSON.parse(await fs.readFile(options.authPath, "utf8"));
    const inheritedAfterFailure = await adoptFreshMainOpenClawProfile(options, latestStore);
    if (inheritedAfterFailure) return inheritedAfterFailure;
    throw error;
  }
  const latestStore = JSON.parse(await fs.readFile(options.authPath, "utf8"));
  const latest = selectedCredential(latestStore, options.format, options.profileId);
  if (latest.refreshToken !== current.refreshToken) return { refreshed: false, skipped: "auth changed" };

  await writeJsonAtomic(
    options.authPath,
    mergeRefreshResponse(latestStore, options.format, options.profileId, response)
  );
  return { refreshed: true, skipped: null };
}

export async function refreshOAuth(options) {
  const runWithStoreLock = () => withFileLock(options.authPath, AUTH_STORE_LOCK_OPTIONS, () => refreshUnderStoreLock(options));
  if (options.format !== "openclaw-auth-profiles" || !options.profileId) return runWithStoreLock();

  const provider = options.profileId.includes(":") ? options.profileId.split(":")[0] : "openai-codex";
  const refreshLock = openClawRefreshLockPath(provider, options.profileId);
  return withFileLock(refreshLock, OAUTH_REFRESH_LOCK_OPTIONS, runWithStoreLock);
}
