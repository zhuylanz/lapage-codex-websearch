import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const scriptPath = path.resolve("scripts", "codex-websearch.mjs");
const imagenScriptPath = path.resolve("scripts", "fixtures", "mock-codex-imagen.mjs");

function jwtWithExpiry(expiresMs) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: Math.floor(expiresMs / 1000) })}.sig`;
}

async function writeAuth(dir, expiresMs = Date.now() + 60_000) {
  const authPath = path.join(dir, "auth.json");
  await fs.writeFile(authPath, `${JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwtWithExpiry(expiresMs), refresh_token: "refresh-secret", account_id: "acct_test" } })}\n`);
  return authPath;
}

async function runCli(args, env = {}) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, CODEX_IMAGEN_SCRIPT: imagenScriptPath, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { code, stdout, stderr };
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("smoke prints redacted metadata", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-websearch-smoke-"));
  const authPath = await writeAuth(tempDir);
  const result = await runCli(["--auth", authPath, "--smoke", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.account_id, "acct_test");
  assert.equal(output.refresh_token_present, true);
  assert.equal(result.stdout.includes("refresh-secret"), false);
  assert.equal(result.stdout.includes(".sig"), false);
});

test("query sends the typed alpha search request and returns URLs", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-websearch-query-"));
  const authPath = await writeAuth(tempDir);
  let captured = null;
  await withServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    captured = { url: request.url, headers: request.headers, body: JSON.parse(raw) };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ encrypted_output: "ciphertext", output: "Result text", results: [{ type: "text_result", ref_id: "turn0search0", url: "https://example.com/result" }] }));
  }, async (baseUrl) => {
    const result = await runCli(["--auth", authPath, "--base-url", baseUrl, "--domains", "example.com", "--recency", "7", "--context", "high", "--json", "current topic"]);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.urls, ["https://example.com/result"]);
    assert.equal(output.encrypted_output_present, true);
  });
  assert.equal(captured.url, "/alpha/search");
  assert.equal(captured.headers["chatgpt-account-id"], "acct_test");
  assert.deepEqual(captured.body.commands.search_query, [{ q: "current topic", recency: 7, domains: ["example.com"] }]);
  assert.equal(captured.body.commands.response_length, "long");
  assert.equal(captured.body.settings.search_context_size, "high");
  assert.equal(captured.body.settings.external_web_access, true);
});

test("open and find operations preserve arguments", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-websearch-open-"));
  const authPath = await writeAuth(tempDir);
  let body = null;
  await withServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    body = JSON.parse(raw);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ output: "Opened", results: [] }));
  }, async (baseUrl) => {
    const result = await runCli(["--auth", authPath, "--base-url", baseUrl, "--open", "https://example.com", "--find", "https://example.com", "install", "--json"]);
    assert.equal(result.code, 0, result.stderr);
  });
  assert.deepEqual(body.commands.open, [{ ref_id: "https://example.com" }]);
  assert.deepEqual(body.commands.find, [{ ref_id: "https://example.com", pattern: "install" }]);
});

test("expired auth refreshes automatically before searching", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-websearch-expired-"));
  const authPath = await writeAuth(tempDir, Date.now() - 60_000);
  let refreshCalls = 0;
  let searchCalls = 0;
  await withServer(async (request, response) => {
    if (request.url === "/oauth/token") {
      refreshCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        access_token: jwtWithExpiry(Date.now() + 60 * 60_000),
        refresh_token: "rotated-refresh-secret",
        expires_in: 3600,
      }));
      return;
    }
    searchCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ output: "Recovered", results: [] }));
  }, async (baseUrl) => {
    const result = await runCli(["--auth", authPath, "--base-url", baseUrl, "--refresh-url", `${baseUrl}/oauth/token`, "--json", "query"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /attempting automatic OAuth refresh/);
    assert.match(result.stderr, /OAuth refresh succeeded/);
  });
  assert.equal(refreshCalls, 1);
  assert.equal(searchCalls, 1);
});

test("HTTP 401 refreshes once and retries the search", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-websearch-401-"));
  const authPath = await writeAuth(tempDir, Date.now() + 60 * 60_000);
  let refreshCalls = 0;
  let searchCalls = 0;
  await withServer(async (request, response) => {
    if (request.url === "/oauth/token") {
      refreshCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        access_token: jwtWithExpiry(Date.now() + 2 * 60 * 60_000),
        refresh_token: "rotated-refresh-secret",
        expires_in: 7200,
      }));
      return;
    }
    searchCalls += 1;
    if (searchCalls === 1) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "access token expired" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ output: "Recovered", results: [] }));
  }, async (baseUrl) => {
    const result = await runCli(["--auth", authPath, "--base-url", baseUrl, "--refresh-url", `${baseUrl}/oauth/token`, "--json", "query"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /HTTP 401/);
  });
  assert.equal(refreshCalls, 1);
  assert.equal(searchCalls, 2);
});

test("failed automatic refresh stops with a clear user-facing error", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-websearch-refresh-failure-"));
  const authPath = await writeAuth(tempDir, Date.now() - 60_000);
  await withServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "refresh token revoked" } }));
  }, async (baseUrl) => {
    const result = await runCli(["--auth", authPath, "--refresh-url", baseUrl, "--json", "query"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /automatic OAuth refresh could not recover/);
    assert.match(result.stderr, /Stop and let the user know/);
    assert.equal(result.stderr.includes("refresh-secret"), false);
  });
});
