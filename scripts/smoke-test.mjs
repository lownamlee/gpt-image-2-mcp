#!/usr/bin/env node
// Drives dist/index.js over MCP stdio against a local mock OpenAI image endpoint.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(root, "dist", "index.js");
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Mock behaviour is selected by the prompt: "slow:<ms>" delays the reply, "fail500" returns 500, "fail400" returns 400.
const requests = [];
const mock = createServer((req, res) => {
  const chunks = [];
  const entry = { url: req.url, aborted: false, finished: false };
  requests.push(entry);
  req.on("data", (chunk) => chunks.push(chunk));
  res.on("close", () => {
    entry.aborted = !entry.finished;
  });
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const isJson = String(req.headers["content-type"] || "").includes("json");
    const body = isJson ? JSON.parse(raw.toString("utf8") || "{}") : {};
    const text = isJson ? body.prompt || "" : raw.toString("latin1");
    entry.body = body;
    entry.multipart = !isJson;
    entry.raw = isJson ? "" : raw.toString("latin1");
    const reply = () => {
      entry.finished = true;
      res.setHeader("content-type", "application/json");
      if (text.includes("fail500")) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: "mock server error", type: "server_error" } }));
        return;
      }
      if (text.includes("fail400")) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: "mock bad request", type: "invalid_request_error" } }));
        return;
      }
      const n = body.n || 1;
      const item = text.includes("nodata") ? {} : { b64_json: PNG_1X1 };
      res.end(JSON.stringify({ created: 1, data: Array.from({ length: n }, () => item), usage: { total_tokens: 1 } }));
    };
    const slow = /slow:(\d+)/.exec(text);
    if (slow) {
      setTimeout(() => {
        if (!res.destroyed) reply();
      }, Number(slow[1]));
    } else {
      reply();
    }
  });
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${mock.address().port}/v1`;

const dataRoot = mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-mcp-smoke-"));
const refImage = path.join(dataRoot, "reference.png");
writeFileSync(refImage, Buffer.from(PNG_1X1, "base64"));
const results = [];
let lastStderr = "";

async function withClient(env, fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, LOCALAPPDATA: dataRoot, XDG_DATA_HOME: dataRoot, OPENAI_API_KEY: "", GPT_IMAGE_OUTPUT_DIR: "", ...env },
    stderr: "pipe",
  });
  lastStderr = "";
  transport.stderr?.on("data", (chunk) => (lastStderr += chunk));
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
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

const call = (client, name, args = {}, options) => client.callTool({ name, arguments: args }, undefined, options);
const textOf = (result) => result.content.find((c) => c.type === "text")?.text ?? "";
const outputRoot = path.join(dataRoot, "gpt-image-2-mcp", "output", "chatgpt-images");
const listDirs = () => (existsSync(outputRoot) ? readdirSync(outputRoot) : []);

try {
  await withClient({ GPT_IMAGE_BACKEND: "api" }, async (client) => {
    await check("tools/list exposes five tools with annotations", async () => {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ["backend_status", "browser_visibility", "collect_images", "generate_image", "list_generations"]);
      for (const tool of tools) assert.ok(tool.annotations, `${tool.name} has annotations`);
      assert.equal(tools.find((t) => t.name === "backend_status").annotations.readOnlyHint, true);
      assert.ok(client.getInstructions()?.includes("list_generations"));
    });

    await check("backend_status api reports missing key and version", async () => {
      const r = await call(client, "backend_status");
      assert.equal(r.structuredContent.statuses[0].ready, false);
      assert.equal(r.structuredContent.server_version, JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version);
      assert.ok(r.structuredContent.statuses[0].details.output_root.startsWith(dataRoot));
    });

    await check("backend_status auto lists both backends without starting a browser", async () => {
      const r = await call(client, "backend_status", { backend: "auto" });
      assert.deepEqual(r.structuredContent.statuses.map((s) => s.backend), ["api", "chatgpt-web"]);
      assert.equal(r.structuredContent.statuses[1].details.session.browser_open, false);
    });

    await check("browser_visibility status and hide work without a browser", async () => {
      const status = await call(client, "browser_visibility", { action: "status" });
      assert.equal(status.structuredContent.browser_open, false);
      const hide = await call(client, "browser_visibility", { action: "hide" });
      assert.equal(hide.structuredContent.applied_action, "hide");
      assert.equal(hide.structuredContent.hide_window, true);
    });

    await check("generate_image api without key returns tool error", async () => {
      const r = await call(client, "generate_image", { prompt: "a red cube", backend: "api" });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /OPENAI_API_KEY is not set/);
    });

    await check("generate_image rejects empty prompt", async () => {
      const r = await call(client, "generate_image", { prompt: "" }).catch((e) => ({ isError: true, content: [{ type: "text", text: String(e) }] }));
      assert.equal(r.isError, true);
      assert.match(textOf(r), /prompt/i);
    });

    await check("list_generations on an empty output folder", async () => {
      const r = await call(client, "list_generations");
      assert.deepEqual(r.structuredContent.generations, []);
    });
  });

  const apiEnv = { GPT_IMAGE_BACKEND: "api", OPENAI_API_KEY: "sk-mock", OPENAI_BASE_URL: baseURL };
  await withClient(apiEnv, async (client) => {
    await check("generate_image api saves PNG files, metadata, and image content", async () => {
      const r = await call(client, "generate_image", { prompt: "A red cube, studio light!", n: 2, size: "1024x1024", quality: "low" });
      assert.notEqual(r.isError, true, textOf(r));
      const s = r.structuredContent;
      assert.equal(s.backend, "api");
      assert.equal(s.images.length, 2);
      assert.match(path.basename(s.output_dir), /^\d{8}-\d{6}-a-red-cube-studio-light$/);
      assert.equal(path.basename(s.image_path), "image-01.png");
      for (const image of s.images) assert.ok(existsSync(image.path), image.path);
      const meta = JSON.parse(readFileSync(path.join(s.output_dir, "metadata.json"), "utf8"));
      assert.equal(meta.model, "gpt-image-2");
      assert.deepEqual(meta.request, { n: 2, size: "1024x1024", quality: "low", output_format: "png", reference_images: [] });
      assert.equal(r.content.filter((c) => c.type === "image" && c.mimeType === "image/png").length, 2);
      const sent = requests.at(-1).body;
      assert.deepEqual([sent.model, sent.n, sent.size, sent.quality, sent.output_format], ["gpt-image-2", 2, "1024x1024", "low", "png"]);
    });

    await check("parallel calls with the same prompt get distinct output folders", async () => {
      const rs = await Promise.all([1, 2, 3].map(() => call(client, "generate_image", { prompt: "same prompt" })));
      const dirs = new Set(rs.map((r) => r.structuredContent.output_dir));
      assert.equal(dirs.size, 3, [...dirs].join(", "));
    });

    await check("non-ASCII prompts get distinct output folders", async () => {
      const a = await call(client, "generate_image", { prompt: "猫のイラスト" });
      const b = await call(client, "generate_image", { prompt: "犬のイラスト" });
      assert.notEqual(a.structuredContent.output_dir, b.structuredContent.output_dir);
    });

    await check("generate_image jpeg writes .jpg", async () => {
      const r = await call(client, "generate_image", { prompt: "jpeg test", output_format: "jpeg" });
      assert.equal(path.extname(r.structuredContent.image_path), ".jpg");
      assert.equal(r.content.find((c) => c.type === "image").mimeType, "image/jpeg");
    });

    await check("return_images none omits image content", async () => {
      const r = await call(client, "generate_image", { prompt: "no inline", return_images: "none" });
      assert.equal(r.content.filter((c) => c.type === "image").length, 0);
      assert.ok(existsSync(r.structuredContent.image_path));
    });

    await check("api backend ignores an empty or non-ChatGPT conversation_url", async () => {
      const empty = await call(client, "generate_image", { prompt: "empty url", conversation_url: "" });
      assert.notEqual(empty.isError, true, textOf(empty));
      assert.deepEqual(empty.structuredContent.warnings, []);
      const junk = await call(client, "generate_image", { prompt: "junk url", backend: "api", conversation_url: "foo" });
      assert.notEqual(junk.isError, true, textOf(junk));
      assert.match(junk.structuredContent.warnings.join(" "), /api backend ignored conversation_url/);
    });

    await check("an API image without data fails and leaves no output folder", async () => {
      const before = listDirs().length;
      const r = await call(client, "generate_image", { prompt: "nodata image" });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /without b64_json or url/);
      assert.equal(listDirs().length, before);
    });

    await check("api backend warns that conversation_url and continue are ignored", async () => {
      const r = await call(client, "generate_image", { prompt: "api continue", conversation_mode: "continue", conversation_url: "https://chatgpt.com/c/abc" });
      assert.notEqual(r.isError, true, textOf(r));
      assert.match(r.structuredContent.warnings.join(" "), /api backend ignored conversation_url and conversation_mode/);
    });

    await check("generate_image auto uses api when key is set", async () => {
      const r = await call(client, "generate_image", { prompt: "auto test", backend: "auto", output_format: "webp" });
      assert.equal(r.structuredContent.backend, "api");
      assert.equal(r.structuredContent.fallback_from, undefined);
      assert.equal(path.extname(r.structuredContent.image_path), ".webp");
    });

    await check("generate_image auto does not fall back on API errors", async () => {
      const r = await call(client, "generate_image", { prompt: "fail400", backend: "auto" });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /mock bad request/);
    });

    await check("API errors are not retried", async () => {
      const before = requests.length;
      const r = await call(client, "generate_image", { prompt: "fail500" });
      assert.equal(r.isError, true);
      assert.equal(requests.length - before, 1);
    });

    await check("reference_images use the edit endpoint with the file attached", async () => {
      const r = await call(client, "generate_image", { prompt: "edit this", reference_images: [refImage] });
      assert.notEqual(r.isError, true, textOf(r));
      const sent = requests.at(-1);
      assert.match(sent.url, /\/images\/edits$/);
      assert.ok(sent.multipart && sent.raw.includes('filename="reference.png"'));
      const meta = JSON.parse(readFileSync(path.join(r.structuredContent.output_dir, "metadata.json"), "utf8"));
      assert.deepEqual(meta.request.reference_images, [refImage]);
    });

    await check("reference_images are validated", async () => {
      const missing = await call(client, "generate_image", { prompt: "x", reference_images: [path.join(dataRoot, "nope.png")] });
      assert.match(textOf(missing), /not found/);
      const wrongType = await call(client, "generate_image", { prompt: "x", reference_images: [serverEntry] });
      assert.match(textOf(wrongType), /must be a \.png/);
    });

    await check("timeout_seconds bounds the API call", async () => {
      const started = Date.now();
      const r = await call(client, "generate_image", { prompt: "slow:45000", timeout_seconds: 30 }, { timeout: 120000 });
      const elapsed = Date.now() - started;
      assert.equal(r.isError, true);
      assert.match(textOf(r), /timed out/i);
      assert.ok(elapsed >= 29000 && elapsed < 40000, `took ${elapsed} ms`);
    });

    await check("client cancellation aborts the upstream request", async () => {
      const dirsBefore = listDirs().length;
      const controller = new AbortController();
      const pending = call(client, "generate_image", { prompt: "slow:8000 cancel me" }, { signal: controller.signal });
      setTimeout(() => controller.abort(), 1000);
      await assert.rejects(pending);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(requests.at(-1).aborted, true, "upstream request was aborted");
      await new Promise((resolve) => setTimeout(resolve, 8000));
      assert.equal(listDirs().length, dirsBefore, "no output folder was written");
    });

    await check("progress notifications are sent during long calls", async () => {
      let progress = 0;
      const r = await call(client, "generate_image", { prompt: "slow:7000 progress" }, { onprogress: () => (progress += 1), timeout: 60000 });
      assert.notEqual(r.isError, true, textOf(r));
      assert.ok(progress >= 1, `progress notifications: ${progress}`);
    });

    await check("list_generations returns newest first and honours limit", async () => {
      const r = await call(client, "list_generations", { limit: 3 });
      const gens = r.structuredContent.generations;
      assert.equal(gens.length, 3);
      const names = gens.map((g) => path.basename(g.output_dir));
      assert.deepEqual(names, [...names].sort().reverse());
      for (const g of gens) assert.ok(g.images.every((p) => existsSync(p)));
    });
  });

  await withClient({ GPT_IMAGE_BACKEND: "auto", OPENAI_API_KEY: "sk-mock", GPT_IMAGE_MODEL: "custom-model" }, async (client) => {
    await check("GPT_IMAGE_BACKEND=auto and GPT_IMAGE_MODEL reach backend_status", async () => {
      const r = await call(client, "backend_status");
      assert.equal(r.structuredContent.default_backend, "auto");
      assert.equal(r.structuredContent.statuses[0].details.model, "custom-model");
      assert.equal(r.structuredContent.statuses[0].ready, true);
    });
  });

  await withClient({ GPT_IMAGE_BACKEND: "chatgpt_web" }, async (client) => {
    await check("invalid GPT_IMAGE_BACKEND is reported", async () => {
      const r = await call(client, "backend_status");
      assert.equal(r.structuredContent.default_backend, "api");
      assert.match(r.structuredContent.warnings.join(" "), /chatgpt_web/);
      assert.match(lastStderr, /Warning: GPT_IMAGE_BACKEND="chatgpt_web"/);
    });
  });

  const customOut = path.join(dataRoot, "custom-out");
  await withClient({ ...apiEnv, GPT_IMAGE_OUTPUT_DIR: customOut }, async (client) => {
    await check("GPT_IMAGE_OUTPUT_DIR sets the output folder", async () => {
      const r = await call(client, "generate_image", { prompt: "custom folder" });
      assert.equal(path.dirname(r.structuredContent.output_dir), customOut);
    });
  });

  await withClient({ GPT_IMAGE_BACKEND: "chatgpt-web", CHATGPT_WEB_IDLE_CLOSE_SECONDS: "10m", CHATGPT_WEB_LOGIN_TIMEOUT_SECONDS: "99999999", CHATGPT_HIDE_WINDOW: "flase" }, async (client) => {
    await check("chatgpt-web default does not launch a browser at startup", async () => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      assert.doesNotMatch(lastStderr, /Starting ChatGPT web browser session/);
      assert.ok(!existsSync(path.join(dataRoot, "gpt-image-2-mcp", "profile")), "profile folder was not created");
    });

    await check("invalid conversation_url is rejected before any browser starts", async () => {
      const started = Date.now();
      const a = await call(client, "generate_image", { prompt: "x", conversation_url: "https://example.com/c/1" });
      const b = await call(client, "collect_images", { conversation_url: "https://chatgpt.com/" });
      assert.match(textOf(a), /must be a chatgpt\.com conversation URL/);
      assert.match(textOf(b), /must be a chatgpt\.com conversation URL/);
      assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
      assert.ok(!existsSync(path.join(dataRoot, "gpt-image-2-mcp", "profile")), "profile folder was not created");
    });

    await check("invalid number and boolean settings are reported", async () => {
      const r = await call(client, "backend_status");
      const warnings = r.structuredContent.warnings.join(" ");
      assert.match(warnings, /CHATGPT_WEB_IDLE_CLOSE_SECONDS="10m"/);
      assert.match(warnings, /CHATGPT_HIDE_WINDOW="flase"/);
      assert.match(warnings, /CHATGPT_WEB_LOGIN_TIMEOUT_SECONDS="99999999"/);
      assert.equal(r.structuredContent.statuses[0].details.default_hide_window, true);
    });
  });
} finally {
  mock.close();
  rmSync(dataRoot, { recursive: true, force: true });
}

console.log(results.join("\n"));
const failed = results.filter((line) => line.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
