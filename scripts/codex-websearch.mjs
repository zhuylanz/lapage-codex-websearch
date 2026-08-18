#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 12_000;
const DEFAULT_AUTH_PATH = path.join(os.homedir(), ".codex", "imagen_auth.json");
const DEFAULT_CODEX_VERSION = "0.147.0";
const DEFAULT_REFRESH_URL = "https://auth.openai.com/oauth/token";
const PACKAGE_VERSION = "1.1.0";
const IMAGEN_REPOSITORY_URL = "https://github.com/zhuylanz/lapage-codex-imagen";

class UsageError extends Error {}
class HttpStatusError extends Error {
  constructor(status, body) {
    super(`Search request failed: HTTP ${status}${body ? `: ${body}` : ""}`);
    this.status = status;
    this.body = body;
  }
}

function usage() {
  return `Usage: codex-websearch [options] <query>

Search operations:
  --query <text>          Add a text query. Repeatable.
  --image-query <text>    Add an image query. Repeatable.
  --open <url-or-ref>     Open a URL or result reference. Repeatable.
  --find <ref> <pattern>  Find text in a URL or result reference. Repeatable.
  --commands-json <json>  Send a complete SearchCommands object.

Search settings:
  --domains <csv>         Restrict queries and results to domains.
  --recency <days>        Restrict queries to recent days.
  --context <size>        low, medium, or high. Default: medium.
  --mode <mode>           cached, indexed, or live. Default: live.
  --response-length <n>   short, medium, or long. Default: long.
  --input <text>          Extra context sent with the search request.
  --model <slug>          Default: ${DEFAULT_MODEL}.
  --max-output-tokens <n> Default: ${DEFAULT_MAX_OUTPUT_TOKENS}.

Authentication and transport:
  --auth <path>           Codex/OpenClaw OAuth JSON.
  --auth-profile <id>     Select an OpenClaw openai-codex profile.
  --base-url <url>        Compatible Codex backend. Default: ${DEFAULT_BASE_URL}.
  --refresh-url <url>     OAuth refresh endpoint. Default: ${DEFAULT_REFRESH_URL}.
  --no-refresh            Disable automatic OAuth refresh and auth retry.
  --timeout <seconds>     Default: ${DEFAULT_TIMEOUT_MS / 1000}.
  --smoke                 Print redacted auth and endpoint metadata only.

Output:
  --json                  Emit structured JSON.
  --debug                 Print safe request diagnostics to stderr.
  --version               Show the CLI version.
  --help                  Show this help.
`;
}

function parseArgs(argv) {
  const options = {
    queries: [],
    imageQueries: [],
    open: [],
    find: [],
    commandsJson: null,
    domains: [],
    recency: null,
    context: "medium",
    mode: "live",
    responseLength: "long",
    input: null,
    model: DEFAULT_MODEL,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    authPath: null,
    authProfile: process.env.CODEX_WEBSEARCH_AUTH_PROFILE || process.env.OPENCLAW_AUTH_PROFILE || null,
    baseUrl: DEFAULT_BASE_URL,
    refreshUrl: process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || DEFAULT_REFRESH_URL,
    refresh: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    smoke: false,
    json: false,
    debug: false,
  };
  const positionals = [];

  const next = (index, flag) => {
    if (index + 1 >= argv.length) throw new UsageError(`${flag} requires a value`);
    return argv[index + 1];
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (arg === "--version" || arg === "-V") {
      process.stdout.write(`${PACKAGE_VERSION}\n`);
      process.exit(0);
    } else if (arg === "--query") {
      options.queries.push(next(index, arg));
      index += 1;
    } else if (arg === "--image-query") {
      options.imageQueries.push(next(index, arg));
      index += 1;
    } else if (arg === "--open") {
      options.open.push({ ref_id: next(index, arg) });
      index += 1;
    } else if (arg === "--find") {
      const refId = next(index, arg);
      if (index + 2 >= argv.length) throw new UsageError("--find requires <ref> <pattern>");
      options.find.push({ ref_id: refId, pattern: argv[index + 2] });
      index += 2;
    } else if (arg === "--commands-json") {
      options.commandsJson = next(index, arg);
      index += 1;
    } else if (arg === "--domains") {
      options.domains.push(...splitCsv(next(index, arg)));
      index += 1;
    } else if (arg === "--recency") {
      options.recency = positiveInteger(next(index, arg), arg);
      index += 1;
    } else if (arg === "--context") {
      options.context = next(index, arg);
      index += 1;
    } else if (arg === "--mode") {
      options.mode = next(index, arg);
      index += 1;
    } else if (arg === "--response-length") {
      options.responseLength = next(index, arg);
      index += 1;
    } else if (arg === "--input") {
      options.input = next(index, arg);
      index += 1;
    } else if (arg === "--model") {
      options.model = next(index, arg);
      index += 1;
    } else if (arg === "--max-output-tokens") {
      options.maxOutputTokens = positiveInteger(next(index, arg), arg);
      index += 1;
    } else if (arg === "--auth") {
      options.authPath = resolveUserPath(next(index, arg));
      index += 1;
    } else if (arg === "--auth-profile") {
      options.authProfile = next(index, arg);
      index += 1;
    } else if (arg === "--base-url") {
      options.baseUrl = next(index, arg);
      index += 1;
    } else if (arg === "--refresh-url") {
      options.refreshUrl = next(index, arg);
      index += 1;
    } else if (arg === "--no-refresh") {
      options.refresh = false;
    } else if (arg === "--timeout") {
      options.timeoutMs = positiveNumber(next(index, arg), arg) * 1000;
      index += 1;
    } else if (arg === "--smoke") {
      options.smoke = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--debug") {
      options.debug = true;
    } else if (arg.startsWith("-")) {
      throw new UsageError(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length > 0) options.queries.push(positionals.join(" "));
  validateOptions(options);
  return options;
}

function splitCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`${flag} must be a positive integer`);
  return parsed;
}

function positiveNumber(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new UsageError(`${flag} must be positive`);
  return parsed;
}

function validateOptions(options) {
  if (!["low", "medium", "high"].includes(options.context)) {
    throw new UsageError("--context must be low, medium, or high");
  }
  if (!["cached", "indexed", "live"].includes(options.mode)) {
    throw new UsageError("--mode must be cached, indexed, or live");
  }
  if (!["short", "medium", "long"].includes(options.responseLength)) {
    throw new UsageError("--response-length must be short, medium, or long");
  }
  if (!options.smoke && !options.commandsJson && options.queries.length === 0 && options.imageQueries.length === 0 && options.open.length === 0 && options.find.length === 0) {
    throw new UsageError("Provide a query or search operation");
  }
  try {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
      throw new UsageError("--base-url must use HTTPS unless it targets loopback");
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Invalid --base-url: ${options.baseUrl}`);
  }
  try {
    const url = new URL(options.refreshUrl);
    if (url.protocol !== "https:" && !isLoopback(url.hostname)) {
      throw new UsageError("--refresh-url must use HTTPS unless it targets loopback");
    }
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`Invalid --refresh-url: ${options.refreshUrl}`);
  }
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function resolveUserPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

async function existingFile(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function imagenScriptCandidates() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const codexHome = process.env.CODEX_HOME?.trim()
    ? resolveUserPath(process.env.CODEX_HOME.trim())
    : path.join(os.homedir(), ".codex");
  const openClawState = process.env.OPENCLAW_STATE_DIR?.trim()
    ? resolveUserPath(process.env.OPENCLAW_STATE_DIR.trim())
    : path.join(os.homedir(), ".openclaw");

  return [
    process.env.CODEX_IMAGEN_SCRIPT,
    path.resolve(scriptDir, "../../codex-imagen/scripts/codex-imagen.mjs"),
    path.join(codexHome, "skills", "codex-imagen", "scripts", "codex-imagen.mjs"),
    path.join(os.homedir(), ".agents", "skills", "codex-imagen", "scripts", "codex-imagen.mjs"),
    path.join(openClawState, "skills", "codex-imagen", "scripts", "codex-imagen.mjs"),
  ].filter(Boolean).map(resolveUserPath);
}

async function resolveImagenScript() {
  for (const candidate of [...new Set(imagenScriptCandidates())]) {
    if (await existingFile(candidate)) return candidate;
  }
  throw new Error(
    `Automatic OAuth refresh requires the codex-imagen skill. Install ${IMAGEN_REPOSITORY_URL} alongside codex-websearch or set CODEX_IMAGEN_SCRIPT to its scripts/codex-imagen.mjs file.`
  );
}

function authCandidates() {
  const codexHome = process.env.CODEX_HOME?.trim()
    ? resolveUserPath(process.env.CODEX_HOME.trim())
    : path.join(os.homedir(), ".codex");
  const openClawState = process.env.OPENCLAW_STATE_DIR?.trim()
    ? resolveUserPath(process.env.OPENCLAW_STATE_DIR.trim())
    : path.join(os.homedir(), ".openclaw");
  const agentDir = process.env.OPENCLAW_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  return [
    process.env.CODEX_WEBSEARCH_AUTH_JSON,
    process.env.CODEX_IMAGEN_AUTH_JSON,
    process.env.OPENCLAW_CODEX_AUTH_JSON,
    process.env.CODEX_AUTH_JSON,
    path.join(codexHome, "imagen_auth.json"),
    agentDir ? path.join(resolveUserPath(agentDir), "auth-profiles.json") : null,
    agentDir ? path.join(resolveUserPath(agentDir), "auth.json") : null,
    path.join(openClawState, "agents", "main", "agent", "auth-profiles.json"),
    path.join(openClawState, "agents", "main", "agent", "auth.json"),
    path.join(openClawState, "credentials", "oauth.json"),
    DEFAULT_AUTH_PATH,
  ].filter(Boolean).map(resolveUserPath);
}

async function resolveAuthPath(options) {
  if (options.authPath) {
    if (!(await existingFile(options.authPath))) throw new Error(`Auth JSON not found: ${options.authPath}`);
    return options.authPath;
  }
  for (const candidate of [...new Set(authCandidates())]) {
    if (await existingFile(candidate)) return candidate;
  }
  throw new Error(`No auth JSON found. Tried:\n${authCandidates().map((candidate) => `  - ${candidate}`).join("\n")}`);
}

function decodeJwtPayload(token) {
  try {
    const part = token.split(".")[1];
    return part ? JSON.parse(Buffer.from(part, "base64url").toString("utf8")) : null;
  } catch {
    return null;
  }
}

function normalizeExpiry(value, accessToken) {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const payload = decodeJwtPayload(accessToken);
  return payload?.exp ? payload.exp * 1000 : null;
}

function selectOpenClawProfile(store, requested) {
  const entries = Object.entries(store.profiles ?? {}).filter(([, profile]) => profile?.type === "oauth" && profile?.provider === "openai-codex");
  if (requested) {
    const profile = store.profiles?.[requested];
    if (!profile) throw new Error(`OpenClaw auth profile not found: ${requested}`);
    return [requested, profile];
  }
  if (entries.length === 0) throw new Error("No openai-codex OAuth profile found");
  entries.sort((left, right) => Number(right[1].expires ?? 0) - Number(left[1].expires ?? 0));
  return entries[0];
}

function parseAuthJson(store, authPath, requestedProfile) {
  if (store?.tokens?.access_token) {
    const accessToken = store.tokens.access_token;
    return {
      authPath,
      format: "codex-auth-json",
      profileId: null,
      accessToken,
      refreshToken: store.tokens.refresh_token ?? null,
      accountId: store.tokens.account_id ?? decodeJwtPayload(store.tokens.id_token)?.chatgpt_account_id ?? null,
      expiresMs: normalizeExpiry(null, accessToken),
    };
  }

  if (store?.profiles) {
    const [profileId, profile] = selectOpenClawProfile(store, requestedProfile);
    return {
      authPath,
      format: "openclaw-auth-profiles",
      profileId,
      accessToken: profile.access ?? profile.access_token,
      refreshToken: profile.refresh ?? profile.refresh_token ?? null,
      accountId: profile.accountId ?? profile.account_id ?? null,
      expiresMs: normalizeExpiry(profile.expires, profile.access ?? profile.access_token),
    };
  }

  const profile = store?.["openai-codex"];
  if (profile?.access || profile?.access_token) {
    const accessToken = profile.access ?? profile.access_token;
    return {
      authPath,
      format: "openclaw-oauth-json",
      profileId: "openai-codex",
      accessToken,
      refreshToken: profile.refresh ?? profile.refresh_token ?? null,
      accountId: profile.accountId ?? profile.account_id ?? null,
      expiresMs: normalizeExpiry(profile.expires, accessToken),
    };
  }

  throw new Error(`Unsupported auth JSON format: ${authPath}`);
}

async function loadAuth(options) {
  const authPath = await resolveAuthPath(options);
  const store = JSON.parse(await fs.readFile(authPath, "utf8"));
  const auth = parseAuthJson(store, authPath, options.authProfile);
  if (!auth.accessToken) throw new Error(`Selected auth profile has no access token: ${authPath}`);
  if (!auth.accountId) throw new Error(`Selected auth profile has no ChatGPT account ID: ${authPath}`);
  return auth;
}

function refreshFailureDetail(result) {
  const detail = String(result.stderr || result.error?.message || "unknown refresh error")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
  return detail || "unknown refresh error";
}

async function refreshAuth(options, auth, reason) {
  if (!options.refresh) {
    throw new Error(`Authentication failed (${reason}), and automatic OAuth refresh is disabled. Stop and let the user know authentication must be restored.`);
  }

  if (!auth.refreshToken) {
    throw new Error(`Authentication failed (${reason}), and no refresh token is available in ${auth.authPath}. Stop and let the user know they must sign in again.`);
  }

  process.stderr.write(`codex-websearch: authentication failed (${reason}); attempting automatic OAuth refresh\n`);
  const imagenScript = await resolveImagenScript();
  const args = [
    imagenScript,
    "--auth",
    auth.authPath,
    "--refresh-only",
    "--json",
    "--quiet",
    "--refresh-url",
    options.refreshUrl,
  ];
  if (auth.profileId) args.push("--auth-profile", auth.profileId);

  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 60_000,
    env: process.env,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`Authentication failed, and automatic OAuth refresh could not recover: ${refreshFailureDetail(result)}. Stop and let the user know they must sign in again.`);
  }

  const refreshed = await loadAuth(options);
  if (refreshed.expiresMs && refreshed.expiresMs <= Date.now()) {
    throw new Error("Authentication failed, and automatic OAuth refresh returned an expired access token. Stop and let the user know they must sign in again.");
  }
  process.stderr.write("codex-websearch: OAuth refresh succeeded; retrying with updated authentication\n");
  return refreshed;
}

async function prepareAuth(options) {
  const auth = await loadAuth(options);
  if (auth.expiresMs && auth.expiresMs <= Date.now()) {
    return refreshAuth(options, auth, "expired access token");
  }
  return auth;
}

function codexVersion() {
  try {
    const output = execFileSync("codex", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).trim();
    return output.match(/\b(?:codex-cli|codex)\s+([^\s]+)/i)?.[1] ?? DEFAULT_CODEX_VERSION;
  } catch {
    return DEFAULT_CODEX_VERSION;
  }
}

function userAgent() {
  return `codex_cli_rs/${codexVersion()} (${process.platform}; ${os.arch()}) codex-websearch/${PACKAGE_VERSION}`;
}

function buildCommands(options) {
  if (options.commandsJson) {
    const parsed = JSON.parse(options.commandsJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError("--commands-json must be a JSON object");
    return parsed;
  }
  const commands = {};
  if (options.queries.length > 0) {
    commands.search_query = options.queries.map((q) => ({ q, ...(options.recency ? { recency: options.recency } : {}), ...(options.domains.length ? { domains: options.domains } : {}) }));
  }
  if (options.imageQueries.length > 0) {
    commands.image_query = options.imageQueries.map((q) => ({ q, ...(options.recency ? { recency: options.recency } : {}), ...(options.domains.length ? { domains: options.domains } : {}) }));
  }
  if (options.open.length > 0) commands.open = options.open;
  if (options.find.length > 0) commands.find = options.find;
  commands.response_length = options.responseLength;
  return commands;
}

function externalWebAccess(mode) {
  if (mode === "cached") return false;
  if (mode === "indexed") return "indexed";
  return true;
}

function buildRequest(options, requestId) {
  const commands = buildCommands(options);
  const input = options.input ?? (options.queries.length ? options.queries.join("\n") : undefined);
  return {
    id: requestId,
    model: options.model,
    ...(input ? { input } : {}),
    commands,
    settings: {
      search_context_size: options.context,
      ...(options.domains.length ? { filters: { allowed_domains: options.domains } } : {}),
      allowed_callers: ["direct"],
      external_web_access: externalWebAccess(options.mode),
    },
    max_output_tokens: options.maxOutputTokens,
  };
}

function endpointUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/alpha/search`;
}

async function search(options, auth) {
  const requestId = randomUUID();
  const endpoint = endpointUrl(options.baseUrl);
  const body = buildRequest(options, requestId);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const startedAt = Date.now();

  if (options.debug) {
    process.stderr.write(`${JSON.stringify({ endpoint, request_id: requestId, model: options.model, commands: body.commands, settings: body.settings }, null, 2)}\n`);
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${auth.accessToken}`,
        "chatgpt-account-id": auth.accountId,
        "content-type": "application/json",
        originator: "codex_cli_rs",
        "session-id": requestId,
        "thread-id": requestId,
        "user-agent": userAgent(),
        "x-client-request-id": requestId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const message = safeErrorMessage(text);
      throw new HttpStatusError(response.status, message);
    }
    const payload = JSON.parse(text);
    return {
      request_id: requestId,
      model: options.model,
      mode: options.mode,
      elapsed_ms: Date.now() - startedAt,
      output: payload.output ?? "",
      results: payload.results ?? [],
      urls: resultUrls(payload.results),
      encrypted_output_present: Boolean(payload.encrypted_output),
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Search request timed out after ${options.timeoutMs / 1000} seconds`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isAuthenticationHttpError(error) {
  if (!(error instanceof HttpStatusError)) return false;
  if (error.status === 401) return true;
  return error.status === 403 && /auth|token|credential|expired|unauthor/i.test(error.body ?? "");
}

function safeErrorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.error?.message ?? parsed?.message ?? parsed?.detail ?? "").slice(0, 1000);
  } catch {
    return text.replace(/\s+/g, " ").trim().slice(0, 500);
  }
}

function resultUrls(results) {
  const urls = [];
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if ((key === "url" || key.endsWith("_url")) && typeof item === "string" && /^https?:\/\//i.test(item)) urls.push(item);
      else visit(item);
    }
  };
  visit(results);
  return [...new Set(urls)];
}

function smokeOutput(options, auth) {
  return {
    auth_path: auth.authPath,
    auth_format: auth.format,
    profile_id: auth.profileId,
    account_id: auth.accountId,
    access_token_expires_in_seconds: auth.expiresMs ? Math.floor((auth.expiresMs - Date.now()) / 1000) : null,
    refresh_token_present: Boolean(auth.refreshToken),
    endpoint: endpointUrl(options.baseUrl),
    model: options.model,
  };
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.output || "(empty search output)"}\n`);
  if (result.urls?.length) {
    process.stdout.write(`\nSources:\n${result.urls.map((url) => `- ${url}`).join("\n")}\n`);
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    let auth = await prepareAuth(options);
    if (options.smoke) {
      printResult(smokeOutput(options, auth), options.json);
      return;
    }
    try {
      printResult(await search(options, auth), options.json);
    } catch (error) {
      if (!isAuthenticationHttpError(error)) throw error;
      auth = await refreshAuth(options, auth, `HTTP ${error.status} from Codex search`);
      try {
        printResult(await search(options, auth), options.json);
      } catch (retryError) {
        if (isAuthenticationHttpError(retryError)) {
          throw new Error(`Authentication failed after automatic OAuth refresh; the Codex search backend still returned HTTP ${retryError.status}. Stop and let the user know they must sign in again.`);
        }
        throw retryError;
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`codex-websearch: ${error.message}\n\n${usage()}`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`codex-websearch: ${error.message}\n`);
    process.exitCode = 1;
  }
}

await main();
