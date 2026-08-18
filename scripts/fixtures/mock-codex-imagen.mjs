#!/usr/bin/env node

import { promises as fs } from "node:fs";

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) throw new Error(`${flag} requires a value`);
  return args[index + 1];
}

const args = process.argv.slice(2);
const authPath = valueAfter(args, "--auth");
const refreshUrl = valueAfter(args, "--refresh-url");
const auth = JSON.parse(await fs.readFile(authPath, "utf8"));
const refreshToken = auth?.tokens?.refresh_token;
if (!refreshToken) throw new Error("mock auth is missing tokens.refresh_token");

const response = await fetch(refreshUrl, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
});
const body = await response.json();
if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);

auth.tokens.access_token = body.access_token;
if (body.refresh_token) auth.tokens.refresh_token = body.refresh_token;
await fs.writeFile(authPath, `${JSON.stringify(auth)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ refreshed: true })}\n`);
