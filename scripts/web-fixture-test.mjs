#!/usr/bin/env node
// Offline test of the chatgpt-web page logic: headless Chrome with https://chatgpt.com/** routed to a local fixture page.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "patchright";

import { installFixtureRoutes, pngWidth } from "./fixture/chatgpt-fixture.mjs";

const web = await import(new URL("../dist/backends/chatgptWeb.js", import.meta.url));
const { loadConfig } = await import(new URL("../dist/config.js", import.meta.url));

const tmp = mkdtempSync(path.join(os.tmpdir(), "gpt-image-2-mcp-web-"));
const outRoot = path.join(tmp, "out");
const config = loadConfig({ ...process.env, LOCALAPPDATA: tmp, XDG_DATA_HOME: tmp, GPT_IMAGE_OUTPUT_DIR: outRoot });
const results = [];
const control = { signedIn: true, historyDelayMs: 0 };

const context = await chromium.launchPersistentContext(path.join(tmp, "profile"), { headless: true, channel: "chrome", viewport: { width: 1280, height: 900 } });
await installFixtureRoutes(context, () => control);
const page = context.pages()[0] || (await context.newPage());

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push(`PASS ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

const send = (prompt, extra = {}) =>
  web.sendPromptAndExport(page, config, { prompt, deadline: Date.now() + 60_000, maxImages: 1, conversationMode: "new", completedTurnGraceMs: 2000, ...extra });
const widthOf = (result) => pngWidth(readFileSync(result.images[0].path));
const outputDirs = () => (existsSync(outRoot) ? readdirSync(outRoot) : []);

try {
  await page.goto("https://chatgpt.com/");

  await check("signed-out page is not ready and not hideable", async () => {
    control.signedIn = false;
    const r = await web.chatPageReadiness(page);
    control.signedIn = true;
    assert.equal(r.ready, false);
    assert.equal(r.hideReady, false);
    assert.equal(r.reason, "not-signed-in");
  });

  await check("signed-in page with sidebar titles mentioning captcha/cloudflare is ready", async () => {
    const r = await web.chatPageReadiness(page);
    assert.equal(r.ready, true, r.reason);
  });

  let first;
  await check("saves the final image, not the in-progress preview, and reports the conversation URL", async () => {
    first = await send("A poster about content policy and a cloudflare captcha security check");
    assert.equal(first.images.length, 1);
    assert.ok(widthOf(first) > 600, `width ${widthOf(first)}`);
    assert.equal(first.images[0].width, widthOf(first));
    assert.match(first.metadata.conversation_url, /^https:\/\/chatgpt\.com\/c\/conv-/);
    assert.deepEqual(first.warnings, []);
  });

  await check("a chat title such as 'Attention required' is not treated as a verification check", async () => {
    const r = await send("Attention Required! | Cloudflare poster parody");
    assert.ok(widthOf(r) > 600);
  });

  await check("text-only reply fails fast with the reply text and conversation URL, leaving no output folder", async () => {
    const before = outputDirs().length;
    const started = Date.now();
    await assert.rejects(send("TEXTONLY please"), /replied without an image: Here is a description.*Conversation: https:\/\/chatgpt\.com\/c\//);
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
    assert.equal(outputDirs().length, before);
  });

  await check("refusal reply is reported as a refusal", async () => {
    await assert.rejects(send("REFUSE this"), (error) => error.name === "ImageGenerationRefusedError" && /violate our content policies/.test(error.message));
  });

  await check("reference images are uploaded and not mistaken for the result", async () => {
    const ref = path.join(tmp, "ref.png");
    const dataUrl = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = c.height = 300;
      c.getContext("2d").fillRect(0, 0, 300, 300);
      return c.toDataURL("image/png");
    });
    writeFileSync(ref, Buffer.from(dataUrl.split(",")[1], "base64"));
    const r = await send("make it blue", { referenceImages: [ref] });
    assert.equal(await page.locator('[data-user-message-bubble] img[alt="User attachment"]').count(), 1, "attachment was sent with the prompt");
    assert.ok(widthOf(r) > 600);
    const meta = JSON.parse(readFileSync(path.join(r.outputDir, "metadata.json"), "utf8"));
    assert.deepEqual(meta.reference_images, [ref]);
  });

  await check("continue mode closes an open dialog and returns the new image, not the previous one", async () => {
    const a = await send("first image");
    await page.evaluate(() => window.openModal(), undefined, false);
    const b = await send("second image", { conversationMode: "continue" });
    assert.notEqual(widthOf(b), widthOf(a));
    assert.equal(b.metadata.conversation_url, a.metadata.conversation_url);
  });

  await check("conversation_url with late-rendering history returns the new image", async () => {
    control.historyDelayMs = 1500;
    const a = await send("history base image");
    await page.goto("https://chatgpt.com/");
    const b = await send("history follow-up", { conversationUrl: a.metadata.conversation_url });
    control.historyDelayMs = 0;
    assert.equal(b.metadata.conversation_url, a.metadata.conversation_url);
    assert.ok(widthOf(b) < widthOf(a), `saved ${widthOf(b)}; the older history image is ${widthOf(a)}`);
  });

  await check("conversation_url and collect wait for history that renders after 3 s", async () => {
    control.historyDelayMs = 3000;
    const a = await send("slow history base image");
    await page.goto("https://chatgpt.com/");
    const b = await send("slow history follow-up", { conversationUrl: a.metadata.conversation_url });
    assert.ok(widthOf(b) < widthOf(a), `saved ${widthOf(b)}; the older history image is ${widthOf(a)}`);
    await page.goto("https://chatgpt.com/");
    const c = await web.collectConversationImages(page, config, { conversationUrl: a.metadata.conversation_url, deadline: Date.now() + 30_000, maxImages: 1 });
    control.historyDelayMs = 0;
    assert.equal(widthOf(c), widthOf(b));
  });

  await check("continue waits for a reply that is still generating, then sends the new prompt", async () => {
    await assert.rejects(send("SLOW12 slow first image", { deadline: Date.now() + 5000 }), /Timed out waiting for an image/);
    const first = await page.evaluate(() => document.querySelectorAll("[data-user-message-bubble]").length);
    const r = await send("follow-up after slow image", { conversationMode: "continue" });
    const state = await page.evaluate(() => ({
      bubbles: document.querySelectorAll("[data-user-message-bubble]").length,
      widths: Array.from(document.querySelectorAll('[data-testid="generated-image-gallery"] img')).map((img) => img.naturalWidth),
    }));
    assert.equal(state.bubbles, first + 1, "the follow-up prompt was sent");
    assert.equal(widthOf(r), state.widths.at(-1));
    assert.notEqual(widthOf(r), state.widths.at(-2));
  });

  await check("continue into a reply still generating at the deadline does not send the prompt", async () => {
    await assert.rejects(send("SLOW30 very slow image", { deadline: Date.now() + 4000 }), /Timed out waiting for an image/);
    await assert.rejects(send("too early", { conversationMode: "continue", deadline: Date.now() + 6000 }), /still generating at the deadline, so the prompt was not sent/);
  });

  await check("collect reports a text-only latest reply and a reply that is still generating", async () => {
    const a = await send("image before text reply");
    await assert.rejects(send("TEXTONLY now", { conversationMode: "continue" }), /replied without an image/);
    const r = await web.collectConversationImages(page, config, { conversationUrl: a.metadata.conversation_url, deadline: Date.now() + 30_000, maxImages: 1 });
    assert.match(r.warnings.join(" "), /latest ChatGPT reply has no image/);
    assert.equal(widthOf(r), widthOf(a));
    await assert.rejects(send("NEVER finishes", { deadline: Date.now() + 4000 }));
    await assert.rejects(
      web.collectConversationImages(page, config, { conversationUrl: page.url(), deadline: Date.now() + 4000, maxImages: 1 }),
      /still generating the latest reply/,
    );
  });

  await check("continue with no open conversation warns that a new chat was started", async () => {
    await page.goto("https://chatgpt.com/");
    const r = await send("continue without chat", { conversationMode: "continue" });
    assert.match(r.warnings.join(" "), /new chat/);
  });

  await check("send button is used when Enter does not send", async () => {
    const r = await send("CLICKSEND image");
    assert.ok(widthOf(r) > 600);
  });

  await check("verification interstitial triggers onBlocked and then recovers", async () => {
    let blocked = 0;
    const r = await send("BLOCK then image", { onBlocked: async () => void (blocked += 1) });
    assert.ok(blocked >= 1, `onBlocked calls: ${blocked}`);
    assert.ok(widthOf(r) > 600);
  });

  await check("cancellation stops the wait promptly", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 1500);
    await assert.rejects(send("NEVER answer", { signal: controller.signal }), /cancelled/);
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  });

  await check("deadline produces a timeout error with conversation URL and diagnostic screenshot", async () => {
    const started = Date.now();
    let message = "";
    await assert.rejects(send("NEVER answer", { deadline: Date.now() + 6000 }), (error) => ((message = error.message), /Timed out waiting for an image/.test(message)));
    assert.ok(Date.now() - started < 12_000, `took ${Date.now() - started} ms`);
    assert.match(message, /Conversation: https:\/\/chatgpt\.com\/c\//);
    const shot = /Diagnostic screenshot: (.+?\.png)/.exec(message)?.[1];
    assert.ok(shot && existsSync(shot), "diagnostic screenshot exists");
  });

  await check("collectConversationImages saves the latest image of a conversation", async () => {
    const a = await send("image to collect later");
    await page.goto("https://chatgpt.com/");
    const r = await web.collectConversationImages(page, config, { conversationUrl: a.metadata.conversation_url, deadline: Date.now() + 30_000, maxImages: 1 });
    assert.equal(widthOf(r), widthOf(a));
    assert.equal(r.metadata.conversation_mode, "collect");
  });

  await check("a failed image export leaves no output folder", async () => {
    const before = outputDirs().length;
    await assert.rejects(send("REVOKE image"));
    assert.equal(outputDirs().length, before);
  });

  await check("a prompt is not sent once the time limit has run out", async () => {
    await page.goto("https://chatgpt.com/");
    const bubbles = await page.evaluate(() => document.querySelectorAll("[data-user-message-bubble]").length);
    await assert.rejects(send("late prompt", { conversationMode: "continue", deadline: Date.now() - 1000 }), /before the prompt could be sent, so it was not sent/);
    assert.equal(await page.evaluate(() => document.querySelectorAll("[data-user-message-bubble]").length), bubbles);
  });

  await check("acquireProfile reports a sign-in timeout after a profile wait without doubling the message", async () => {
    let calls = 0;
    const error = await web
      .acquireProfile(path.join(tmp, "acq-profile"), Date.now() + 9000, undefined, () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new web.ProfileInUseError("held by other", "chatgpt-web")) : new Promise(() => undefined);
      }, () => new Error("not signed in"))
      .catch((e) => e);
    assert.equal(error.message, "not signed in");
    const ack = path.join(tmp, "acq-profile2.release-ack");
    const waited = await web
      .acquireProfile(path.join(tmp, "acq-profile2"), Date.now() + 9000, undefined, () => {
        writeFileSync(ack, "ack");
        return Promise.reject(new web.ProfileInUseError("held by other", "chatgpt-web"));
      }, () => new Error("not signed in"))
      .catch((e) => e);
    assert.match(waited.message, /^Waited \d+s for the ChatGPT browser profile\. held by other$/);
  });

  await check("conversation_url must be a chatgpt.com URL", async () => {
    await assert.rejects(send("x", { conversationUrl: "https://example.com/c/1" }), /must be a chatgpt\.com conversation URL/);
  });

  await check("generationFailureReason ignores ordinary text and matches limit messages", async () => {
    assert.equal(web.generationFailureReason("Here is your image of a sunset."), null);
    assert.ok(web.generationFailureReason("You’ve hit the free plan limit for image generation. Try again in 2 hours."));
  });

  await check("looksBlocked matches Cloudflare interstitial titles only", async () => {
    assert.equal(web.looksBlocked({ title: "Just a moment...", url: "https://chatgpt.com/" }), true);
    assert.equal(web.looksBlocked({ title: "A neon sign that says Just a moment", url: "https://chatgpt.com/c/1" }), false);
    assert.equal(web.looksBlocked({ title: "ChatGPT", url: "https://chatgpt.com/", challenge: true }), true);
  });
} finally {
  await context.close();
}

await check("a crashed ChatGPT tab is replaced on the next call", async () => {
  const controlFile = path.join(tmp, "control.json");
  writeFileSync(controlFile, JSON.stringify({ signedIn: true }));
  process.env.FIXTURE_CONTROL = controlFile;
  await import("./fixture/preload.mjs");
  const crashRoot = path.join(tmp, "crash");
  const backend = new web.ChatGptWebBackend(loadConfig({ ...process.env, LOCALAPPDATA: crashRoot, XDG_DATA_HOME: crashRoot, GPT_IMAGE_OUTPUT_DIR: path.join(crashRoot, "out"), CHATGPT_WEB_IDLE_CLOSE_SECONDS: "0" }));
  try {
    const args = { prompt: "crash test image", n: 1, outputFormat: "png", conversationMode: "new", timeoutSeconds: 60 };
    await backend.generateImage(args);
    await backend.directSession.page.goto("chrome://crash").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const r = await backend.generateImage(args);
    assert.ok(r.images.length === 1);
  } finally {
    await backend.close();
  }
});
rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });

console.log(results.join("\n"));
const failed = results.filter((line) => line.startsWith("FAIL")).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
