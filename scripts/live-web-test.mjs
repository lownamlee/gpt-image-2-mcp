#!/usr/bin/env node
// Live end-to-end check of the chatgpt-web backend against real chatgpt.com.
// Needs a signed-in MCP profile (see README "Reuse Your Chrome Sign-In") and no other MCP session using it.
// Sends four real image prompts to the signed-in ChatGPT account.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IDLE_SECONDS = 20;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
  env: { ...process.env, GPT_IMAGE_BACKEND: "chatgpt-web", CHATGPT_WEB_IDLE_CLOSE_SECONDS: String(IDLE_SECONDS) },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => (stderr += chunk));
const client = new Client({ name: "live-web-test", version: "1.0.0" });
await client.connect(transport);

const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push(`PASS ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}
const call = (name, args = {}, options = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 600_000, ...options });
const textOf = (r) => r.content.find((c) => c.type === "text")?.text ?? "";
const pngWidth = (file) => readFileSync(file).readUInt32BE(16);

let first;
try {
  await check("server starts without launching a browser", async () => {
    const r = await call("backend_status");
    assert.equal(r.structuredContent.statuses[0].details.session.browser_open, false);
  });

  await check("generate_image (new chat) saves a full-size image and reports ignored params", async () => {
    let progress = 0;
    const visibility = [];
    const pending = call("generate_image", { prompt: "Generate an image: a flat vector icon of a red apple on white", size: "1024x1024", return_images: "none" }, { onprogress: () => (progress += 1) });
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const started = Date.now();
    await call("browser_visibility", { action: "status" });
    visibility.push(Date.now() - started);
    first = await pending;
    assert.notEqual(first.isError, true, textOf(first));
    const s = first.structuredContent;
    assert.ok(existsSync(s.image_path));
    assert.ok(pngWidth(s.image_path) >= 1024, `width ${pngWidth(s.image_path)}`);
    assert.equal(first.content.filter((c) => c.type === "image").length, 0);
    assert.deepEqual(s.warnings, ["The chatgpt-web backend ignored: size."]);
    assert.match(s.conversation_url, /^https:\/\/chatgpt\.com\/c\//);
    assert.ok(progress >= 1, `progress ${progress}`);
    assert.ok(visibility[0] < 3000, `browser_visibility during generation took ${visibility[0]} ms`);
  });

  let second;
  await check("conversation_url continues the same chat and returns the new image", async () => {
    await call("generate_image", { prompt: "Generate an image: a small blue circle icon", return_images: "none" });
    second = await call("generate_image", { prompt: "Generate an image: the same apple, but green", conversation_url: first.structuredContent.conversation_url, return_images: "none" });
    assert.notEqual(second.isError, true, textOf(second));
    assert.equal(second.structuredContent.conversation_url, first.structuredContent.conversation_url);
    assert.deepEqual(second.structuredContent.warnings, []);
    assert.notEqual(readFileSync(second.structuredContent.image_path).toString("base64"), readFileSync(first.structuredContent.image_path).toString("base64"));
  });

  await check("collect_images saves the latest image of the conversation", async () => {
    const r = await call("collect_images", { conversation_url: first.structuredContent.conversation_url, return_images: "none" });
    assert.notEqual(r.isError, true, textOf(r));
    assert.equal(readFileSync(r.structuredContent.image_path).toString("base64"), readFileSync(second.structuredContent.image_path).toString("base64"));
  });

  await check("reference_images uploads a file and returns a new image", async () => {
    const r = await call("generate_image", { prompt: "Generate an image: this apple in a pencil sketch style", reference_images: [first.structuredContent.image_path], return_images: "none" });
    assert.notEqual(r.isError, true, textOf(r));
    assert.notEqual(readFileSync(r.structuredContent.image_path).toString("base64"), readFileSync(first.structuredContent.image_path).toString("base64"));
  });

  await check("list_generations returns the new outputs", async () => {
    const r = await call("list_generations", { limit: 5 });
    assert.equal(r.structuredContent.generations.length, 5);
    assert.equal(r.structuredContent.generations[4].output_dir, first.structuredContent.output_dir);
  });

  await check(`browser closes after ${IDLE_SECONDS}s idle`, async () => {
    await new Promise((resolve) => setTimeout(resolve, (IDLE_SECONDS + 5) * 1000));
    const r = await call("backend_status");
    assert.equal(r.structuredContent.statuses[0].details.session.browser_open, false);
    assert.match(stderr, /Closing idle ChatGPT browser/);
  });
} finally {
  await client.close();
}

console.log(results.join("\n"));
const failed = results.filter((line) => line.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
