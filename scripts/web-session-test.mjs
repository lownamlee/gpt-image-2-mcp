#!/usr/bin/env node
// Offline end-to-end test of the chatgpt-web session over MCP stdio: the real dist/index.js runs with
// scripts/fixture/preload.mjs, so its browser is headless and sees the local chatgpt.com fixture.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "patchright";

import { pngWidth } from "./fixture/chatgpt-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const preload = pathToFileURL(path.join(root, "scripts", "fixture", "preload.mjs")).href;
const tmp = mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-mcp-session-"));
const controlFile = path.join(tmp, "control.json");
const outRoot = path.join(tmp, "out");
const setControl = (control) => writeFileSync(controlFile, JSON.stringify(control));
setControl({ signedIn: true, historyDelayMs: 0 });

const results = [];
const clients = [];
async function startServer(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", preload, path.join(root, "dist", "index.js")],
    env: { ...process.env, LOCALAPPDATA: tmp, XDG_DATA_HOME: tmp, GPT_IMAGE_OUTPUT_DIR: outRoot, GPT_IMAGE_BACKEND: "chatgpt-web", FIXTURE_CONTROL: controlFile, ...env },
    stderr: "pipe",
  });
  const server = { stderr: "" };
  transport.stderr?.on("data", (chunk) => (server.stderr += chunk));
  server.client = new Client({ name: "web-session-test", version: "1.0.0" });
  await server.client.connect(transport);
  clients.push(server.client);
  server.call = (name, args = {}, options = {}) => server.client.callTool({ name, arguments: args }, undefined, { timeout: 300_000, ...options });
  return server;
}

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push(`PASS ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

const textOf = (r) => r.content.find((c) => c.type === "text")?.text ?? "";
const widthOf = (r) => pngWidth(readFileSync(r.structuredContent.image_path));
const sessionOf = async (server) => (await server.call("backend_status")).structuredContent.statuses[0].details.session;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await fn()) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

try {
  const a = await startServer({ CHATGPT_WEB_IDLE_CLOSE_SECONDS: "6" });
  let first;

  await check("default chatgpt-web call has no warnings and a top-level conversation_url", async () => {
    first = await a.call("generate_image", { prompt: "a red apple", return_images: "none" });
    assert.notEqual(first.isError, true, textOf(first));
    assert.deepEqual(first.structuredContent.warnings, []);
    assert.match(first.structuredContent.conversation_url, /^https:\/\/chatgpt\.com\/c\//);
  });

  await check("explicit api-only parameters are reported as ignored", async () => {
    const r = await a.call("generate_image", { prompt: "a pear", size: "1024x1024", output_format: "webp", return_images: "none" });
    assert.match(r.structuredContent.warnings.join(" "), /ignored: size, output_format/);
  });

  await check("a queued call times out with a queue message and a queued cancel returns promptly", async () => {
    const slow = a.call("generate_image", { prompt: "SLOW40 image", timeout_seconds: 90, return_images: "none" });
    await sleep(1000);
    const controller = new AbortController();
    const cancelStarted = Date.now();
    const cancelled = a.call("generate_image", { prompt: "queued cancel" }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 1000);
    await assert.rejects(cancelled);
    assert.ok(Date.now() - cancelStarted < 5000, `cancel took ${Date.now() - cancelStarted} ms`);
    const started = Date.now();
    const queued = await a.call("generate_image", { prompt: "queued", timeout_seconds: 30 });
    assert.equal(queued.isError, true);
    assert.match(textOf(queued), /waiting for another image generation/);
    assert.ok(Date.now() - started < 34_000, `queued call took ${Date.now() - started} ms`);
    const slowResult = await slow;
    assert.notEqual(slowResult.isError, true, textOf(slowResult));
    await sleep(3000);
    const prompts = (await a.call("list_generations", { limit: 20 })).structuredContent.generations.map((g) => g.prompt);
    assert.ok(!prompts.includes("queued cancel"), "the cancelled call never ran on the server");
  });

  await check("continue after idle close reopens the last conversation", async () => {
    const before = await a.call("generate_image", { prompt: "before idle", return_images: "none" });
    await waitFor(async () => !(await sessionOf(a)).browser_open, 20_000, "idle close");
    assert.match(a.stderr, /Closing idle ChatGPT browser/);
    const after = await a.call("generate_image", { prompt: "after idle", conversation_mode: "continue", return_images: "none" });
    assert.notEqual(after.isError, true, textOf(after));
    assert.equal(after.structuredContent.conversation_url, before.structuredContent.conversation_url);
    assert.deepEqual(after.structuredContent.warnings, []);
  });

  await check("collect_images saves the latest image of a conversation", async () => {
    const r = await a.call("collect_images", { conversation_url: first.structuredContent.conversation_url, return_images: "none" });
    assert.notEqual(r.isError, true, textOf(r));
    assert.equal(widthOf(r), widthOf(first));
  });

  await check("text-only failure includes the conversation URL", async () => {
    const r = await a.call("generate_image", { prompt: "TEXTONLY reply" });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Conversation: https:\/\/chatgpt\.com\/c\//);
    assert.equal((await sessionOf(a)).last_conversation_url, /Conversation: (\S+)/.exec(textOf(r))[1]);
  });

  await waitFor(async () => !(await sessionOf(a)).browser_open, 20_000, "idle close before sign-out tests");

  await check("browser_visibility start_browser returns promptly while signed out, and idle close waits for sign-in", async () => {
    setControl({ signedIn: false });
    const started = Date.now();
    const r = await a.call("browser_visibility", { action: "show", start_browser: true });
    assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
    assert.notEqual(r.isError, true, textOf(r));
    assert.equal(r.structuredContent.browser_open, true);
    assert.match(r.structuredContent.message, /Waiting for ChatGPT sign-in/);
    await sleep(10_000);
    const pending = await sessionOf(a);
    assert.equal(pending.browser_open, true, "browser stayed open during sign-in");
    assert.equal(pending.starting, true);
    setControl({ signedIn: true });
    await waitFor(async () => (await sessionOf(a)).ready, 20_000, "sign-in");
    await waitFor(async () => !(await sessionOf(a)).browser_open, 20_000, "idle close after start_browser");
  });

  await check("a second server waits for the profile and the idle owner hands it over", async () => {
    const owner = await startServer({ CHATGPT_WEB_IDLE_CLOSE_SECONDS: "0" });
    const r1 = await owner.call("generate_image", { prompt: "owner image", return_images: "none" });
    assert.notEqual(r1.isError, true, textOf(r1));
    const started = Date.now();
    const r2 = await a.call("generate_image", { prompt: "waiter image", return_images: "none", timeout_seconds: 120 });
    assert.notEqual(r2.isError, true, textOf(r2));
    assert.match(owner.stderr, /so another gpt-image-2 MCP session can use the profile/);
    assert.equal((await sessionOf(owner)).browser_open, false);
    assert.ok(Date.now() - started < 60_000, `handoff took ${Date.now() - started} ms`);
  });

  const profileDir = path.join(tmp, "gpt-image-2-mcp", "profile");
  const releaseFile = `${profileDir}.release-request`;
  await waitFor(async () => !(await sessionOf(a)).browser_open, 20_000, "idle close before hand-off edge cases");

  await check("an idle owner ignores a stale release request", async () => {
    const owner = await startServer({ CHATGPT_WEB_IDLE_CLOSE_SECONDS: "0" });
    const r = await owner.call("generate_image", { prompt: "stale owner image", return_images: "none" });
    assert.notEqual(r.isError, true, textOf(r));
    await sleep(13_000);
    writeFileSync(releaseFile, "old");
    const old = new Date(Date.now() - 11_000);
    utimesSync(releaseFile, old, old);
    await sleep(4000);
    assert.equal((await sessionOf(owner)).browser_open, true);
    await owner.client.close();
    await sleep(1500);
  });

  await check("a waiter that gives up reports the profile wait and withdraws its request", async () => {
    const owner = await startServer({ CHATGPT_WEB_IDLE_CLOSE_SECONDS: "0" });
    const busy = owner.call("generate_image", { prompt: "SLOW45 busy owner", timeout_seconds: 120, return_images: "none" });
    await sleep(8000);
    const r = await a.call("generate_image", { prompt: "impatient waiter", timeout_seconds: 30 });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Waited \d+s for the ChatGPT browser profile/);
    assert.ok(!existsSync(releaseFile), "release request removed");
    const done = await busy;
    assert.notEqual(done.isError, true, textOf(done));
    await sleep(4000);
    assert.equal((await sessionOf(owner)).browser_open, true, "owner kept its browser");
    await owner.client.close();
    await sleep(1500);
  });

  await check("a profile held by a program that is not a gpt-image-2 session fails fast", async () => {
    const foreign = await chromium.launchPersistentContext(profileDir, { headless: true, channel: "chrome" });
    try {
      const started = Date.now();
      const r = await a.call("generate_image", { prompt: "blocked by foreign", timeout_seconds: 120 });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /did not answer the gpt-image-2 hand-off request/);
      assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms`);
    } finally {
      await foreign.close();
    }
    await sleep(1500);
  });

  await check("browser_visibility start_browser takes the profile over from an idle owner", async () => {
    const owner = await startServer({ CHATGPT_WEB_IDLE_CLOSE_SECONDS: "0" });
    const r1 = await owner.call("generate_image", { prompt: "visibility owner image", return_images: "none" });
    assert.notEqual(r1.isError, true, textOf(r1));
    const r = await a.call("browser_visibility", { action: "show", start_browser: true });
    assert.notEqual(r.isError, true, textOf(r));
    assert.equal(r.structuredContent.browser_open, true);
    assert.equal((await sessionOf(owner)).browser_open, false);
    await owner.client.close();
  });

  await check("import-chrome-cookies copies the session cookie and takes the profile over from an idle owner", async () => {
    const sourceDir = path.join(tmp, "source-chrome");
    const source = await chromium.launchPersistentContext(sourceDir, { headless: true, channel: "chrome", args: ["--remote-debugging-port=0"] });
    try {
      await source.addCookies([
        { name: "__Secure-next-auth.session-token", value: "fixture-token", domain: ".chatgpt.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 3600 },
        { name: "unrelated", value: "x", domain: ".example.com", path: "/", expires: Math.floor(Date.now() / 1000) + 3600 },
      ]);
      await waitFor(async () => existsSync(path.join(sourceDir, "DevToolsActivePort")), 10_000, "DevToolsActivePort");
      const owner = await startServer({ CHATGPT_WEB_IDLE_CLOSE_SECONDS: "0" });
      const r = await owner.call("generate_image", { prompt: "import owner image", return_images: "none" });
      assert.notEqual(r.isError, true, textOf(r));
      const { spawnSync } = await import("node:child_process");
      const run = spawnSync(process.execPath, [path.join(root, "dist", "index.js"), "import-chrome-cookies"], {
        env: { ...process.env, LOCALAPPDATA: tmp, CHROME_USER_DATA_DIR: sourceDir },
        encoding: "utf8",
        timeout: 120_000,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stderr, /Imported 1 chatgpt\.com\/openai\.com cookies/);
      assert.equal((await sessionOf(owner)).browser_open, false, "owner handed the profile over");
      await owner.client.close();
      await sleep(1500);
      const imported = await chromium.launchPersistentContext(profileDir, { headless: true, channel: "chrome" });
      const cookies = await imported.cookies("https://chatgpt.com/");
      await imported.close();
      assert.ok(cookies.some((cookie) => cookie.name === "__Secure-next-auth.session-token" && cookie.value === "fixture-token"));
      assert.ok(!cookies.some((cookie) => cookie.name === "unrelated"));
    } finally {
      await source.close();
    }
  });

  await check("the window is hidden again after a verification check clears during a call", async () => {
    const plain = await a.call("generate_image", { prompt: "before block", return_images: "none" });
    assert.notEqual(plain.isError, true, textOf(plain));
    const logStart = a.stderr.length;
    const r = await a.call("generate_image", { prompt: "BLOCK then image", conversation_mode: "continue", return_images: "none" });
    assert.notEqual(r.isError, true, textOf(r));
    assert.match(a.stderr.slice(logStart), /ChatGPT browser hidden after after-generate/);
  });

  await check("a verification check on page load shows the window and leaves it visible", async () => {
    setControl({ signedIn: true, blockLoadMs: 600_000 });
    const r = await a.call("generate_image", { prompt: "blocked on load", timeout_seconds: 30 });
    setControl({ signedIn: true });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /verification/, textOf(r));
    const session = await sessionOf(a);
    assert.equal(session.hidden, false, "window stays visible for the check");
  });

  await check("browser_visibility start_browser works with the default status action", async () => {
    await waitFor(async () => !(await sessionOf(a)).browser_open, 30_000, "browser closed before status start");
    const r = await a.call("browser_visibility", { start_browser: true });
    assert.notEqual(r.isError, true, textOf(r));
    assert.equal(r.structuredContent.browser_open, true);
  });

  await check("import-chrome-cookies takes the profile from a session that is waiting for sign-in", async () => {
    const sourceDir = path.join(tmp, "source-chrome-2");
    const source = await chromium.launchPersistentContext(sourceDir, { headless: true, channel: "chrome", args: ["--remote-debugging-port=0"] });
    try {
      await source.addCookies([{ name: "__Secure-next-auth.session-token", value: "fixture-token-2", domain: ".chatgpt.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 3600 }]);
      await waitFor(async () => existsSync(path.join(sourceDir, "DevToolsActivePort")), 10_000, "DevToolsActivePort");
      const waiting = await startServer({ CHATGPT_WEB_IDLE_CLOSE_SECONDS: "0" });
      await waitFor(async () => !(await sessionOf(a)).browser_open, 30_000, "idle close of the first session");
      setControl({ signedIn: false });
      const opened = await waiting.call("browser_visibility", { action: "show", start_browser: true });
      assert.match(textOf(opened), /Waiting for ChatGPT sign-in/);
      const { spawnSync } = await import("node:child_process");
      const run = spawnSync(process.execPath, [path.join(root, "dist", "index.js"), "import-chrome-cookies"], {
        env: { ...process.env, LOCALAPPDATA: tmp, CHROME_USER_DATA_DIR: sourceDir },
        encoding: "utf8",
        timeout: 120_000,
      });
      setControl({ signedIn: true });
      assert.equal(run.status, 0, run.stderr);
      const after = await sessionOf(waiting);
      assert.equal(after.browser_open, false);
      assert.equal(after.last_error, undefined, "a hand-off is not reported as a startup failure");
      await waiting.client.close();
    } finally {
      await source.close();
    }
  });

  await check("failed calls leave no empty output folders", async () => {
    const empty = readdirSync(outRoot).filter((name) => readdirSync(path.join(outRoot, name)).length === 0);
    assert.deepEqual(empty, []);
  });
} finally {
  await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  await sleep(1000);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

console.log(results.join("\n"));
const failed = results.filter((line) => line.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
