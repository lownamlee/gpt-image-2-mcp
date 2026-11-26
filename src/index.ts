#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { BackendSelectionSchema, ConversationModeSchema, ImageQualitySchema, loadConfig, OutputFormatSchema } from "./config.js";
import { createBackends, generateWithSelectedBackend, selectedBackend } from "./backends/resolve.js";
import { isConversationUrl } from "./backends/chatgptWeb.js";
import type { GenerateImageResult, GeneratedImage } from "./backends/types.js";
import { importChromeCookies } from "./importChromeCookies.js";

const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const REFERENCE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_REFERENCE_IMAGE_BYTES = 50 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 5000;

const config = loadConfig();
const backends = createBackends(config);
const server = new McpServer(
  {
    name: "gpt-image-2-mcp",
    version: PACKAGE_VERSION,
  },
  {
    instructions: [
      "generate_image saves images to disk and returns their paths (image_path, images[].path) plus the image data unless return_images is \"none\".",
      "The chatgpt-web backend drives a ChatGPT browser session: usually one image per call (n caps how many are saved), typically 20 seconds to a few minutes; size, quality and output_format apply only to the api backend.",
      "To refine the previous image, call generate_image again with conversation_url from the previous result, or with reference_images pointing at saved files.",
      "If a chatgpt-web call times out, its error includes the conversation URL (backend_status also reports last_conversation_url); collect_images saves the image once ChatGPT finishes.",
      "Use list_generations to find earlier outputs instead of regenerating. Use backend_status to check readiness and browser_visibility to show the ChatGPT window when sign-in or verification is needed.",
    ].join(" "),
  },
);
let shuttingDown = false;

const GenerateImageInput = z.object({
  prompt: z.string().min(1).describe("Image prompt to send to the selected backend."),
  backend: BackendSelectionSchema.optional().describe("Backend to use: api, chatgpt-web, or auto (api first, chatgpt-web when no API key is set). Defaults to GPT_IMAGE_BACKEND."),
  n: z.number().int().min(1).max(4).default(1).describe("Number of images to generate (api backend). The chatgpt-web backend saves at most this many of the images ChatGPT produces, usually one."),
  size: z.string().optional().describe("api backend only: an OpenAI-supported size such as 1024x1024, 1536x1024, 1024x1536, or auto."),
  quality: ImageQualitySchema.optional().describe("api backend only: low, medium, high, or auto."),
  output_format: OutputFormatSchema.optional().describe("api backend only: png (default), jpeg, or webp."),
  reference_images: z
    .array(z.string().min(1))
    .max(10)
    .optional()
    .describe("Absolute paths of local PNG, JPEG, or WebP images to edit or use as references. api uses the image edit endpoint; chatgpt-web uploads them to the chat."),
  conversation_mode: ConversationModeSchema.default("new").describe("chatgpt-web only: new starts a new chat; continue sends the prompt in the chat that is open, or the last chat this session used."),
  conversation_url: z
    .string()
    .optional()
    .describe("chatgpt-web only: a chatgpt.com conversation URL (conversation_url from an earlier result) to continue in that chat."),
  return_images: z
    .enum(["inline", "none"])
    .default("inline")
    .describe("inline returns the image data as MCP image content; none returns only file paths and metadata, which keeps responses small."),
  timeout_seconds: z.number().int().min(30).max(1800).default(420).describe("Overall time limit in seconds, including browser start and sign-in waits."),
});

const BackendStatusInput = z.object({
  backend: BackendSelectionSchema.optional().describe("Backend to inspect. Defaults to GPT_IMAGE_BACKEND; auto reports both backends."),
});

const BrowserVisibilityInput = z.object({
  action: z.enum(["show", "hide", "toggle", "status"]).default("status").describe("Browser visibility action for the ChatGPT web backend."),
  start_browser: z.boolean().default(false).describe("Start the ChatGPT browser session if no browser is open."),
});

const CollectImagesInput = z.object({
  conversation_url: z.string().describe("chatgpt.com conversation URL, for example from a timed-out generate_image error or an earlier result."),
  n: z.number().int().min(1).max(4).default(1).describe("Number of most recent generated images in the conversation to save."),
  return_images: z.enum(["inline", "none"]).default("inline").describe("inline returns the image data; none returns only file paths and metadata."),
  timeout_seconds: z.number().int().min(30).max(1800).default(180).describe("Overall time limit in seconds, including waiting for an unfinished image."),
});

const ListGenerationsInput = z.object({
  limit: z.number().int().min(1).max(100).default(10).describe("Maximum number of generations to return, newest first."),
});

function errorResult(error: unknown, configWarnings: string[] = []): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text", text: configWarnings.length ? `${message} Configuration warnings: ${configWarnings.join(" ")}` : message }],
  };
}

async function validateReferenceImages(paths: string[] | undefined): Promise<string[] | undefined> {
  if (!paths?.length) {
    return undefined;
  }
  const resolved: string[] = [];
  for (const file of paths) {
    const absolute = path.resolve(file);
    if (!REFERENCE_IMAGE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) {
      throw new Error(`Reference image must be a .png, .jpg, .jpeg, or .webp file: ${absolute}`);
    }
    const info = await stat(absolute).catch(() => undefined);
    if (!info?.isFile()) {
      throw new Error(`Reference image not found: ${absolute}`);
    }
    if (info.size > MAX_REFERENCE_IMAGE_BYTES) {
      throw new Error(`Reference image is larger than 50 MB: ${absolute}`);
    }
    resolved.push(absolute);
  }
  return resolved;
}

function ignoredWebParams(args: { size?: string; quality?: string; output_format?: string }): string[] {
  return (["size", "quality", "output_format"] as const).filter((key) => args[key] !== undefined);
}

type ToolExtra = { _meta?: { progressToken?: string | number }; sendNotification: (notification: never) => Promise<void> };

function startProgress(extra: ToolExtra, label: string): () => void {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) {
    return () => undefined;
  }
  const started = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    void extra
      .sendNotification({ method: "notifications/progress", params: { progressToken, progress: elapsed, message: `${label} (${elapsed}s elapsed)` } } as never)
      .catch(() => undefined);
  }, PROGRESS_INTERVAL_MS);
  return () => clearInterval(timer);
}

server.registerTool(
  "generate_image",
  {
    title: "Generate image",
    description:
      "Generate or edit images with the OpenAI gpt-image-2 API backend or the ChatGPT website backend. Saves files to disk and returns output_dir, image_path, images, and (unless return_images is none) the image data. chatgpt-web calls usually take 20 seconds to a few minutes.",
    inputSchema: GenerateImageInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async (rawArgs, extra): Promise<CallToolResult> => {
    const args = GenerateImageInput.parse(rawArgs);
    const selection = args.backend || config.defaultBackend;
    const stopProgress = startProgress(extra as unknown as ToolExtra, "Generating image");
    try {
      const conversationUrl = args.conversation_url?.trim() || undefined;
      if (conversationUrl && selection !== "api" && !isConversationUrl(conversationUrl)) {
        throw new Error(`conversation_url must be a chatgpt.com conversation URL: ${conversationUrl}`);
      }
      const referenceImages = await validateReferenceImages(args.reference_images);
      const result = await generateWithSelectedBackend({
        backends,
        selection,
        args: {
          prompt: args.prompt,
          n: args.n,
          size: args.size,
          quality: args.quality,
          outputFormat: args.output_format ?? "png",
          conversationMode: args.conversation_mode,
          conversationUrl: selection === "api" ? undefined : conversationUrl,
          referenceImages,
          timeoutSeconds: args.timeout_seconds,
          signal: extra.signal,
        },
      });
      const warnings = [...(result.warnings ?? [])];
      if (result.backend === "chatgpt-web") {
        const ignored = ignoredWebParams(args);
        if (ignored.length > 0) {
          warnings.push(`The chatgpt-web backend ignored: ${ignored.join(", ")}.`);
        }
      } else if (conversationUrl || args.conversation_mode === "continue") {
        warnings.push("The api backend ignored conversation_url and conversation_mode; pass the earlier image in reference_images to edit it.");
      }
      return await imageResultToToolResult({ ...result, warnings }, selection, args.return_images);
    } catch (error) {
      return errorResult(error, config.warnings);
    } finally {
      stopProgress();
    }
  },
);

server.registerTool(
  "backend_status",
  {
    title: "Backend status",
    description: "Show configuration and readiness for the API and ChatGPT web backends, including the output folder and whether the ChatGPT browser is signed in.",
    inputSchema: BackendStatusInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (rawArgs): Promise<CallToolResult> => {
    const args = BackendStatusInput.parse(rawArgs);
    const selection = args.backend || config.defaultBackend;
    const statuses =
      selection === "auto"
        ? [await backends.api.status(), await backends["chatgpt-web"].status()]
        : [await selectedBackend(backends, selection).status()];
    const summary = {
      selected_backend: selection,
      default_backend: config.defaultBackend,
      server_version: PACKAGE_VERSION,
      warnings: config.warnings,
      statuses,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary,
    };
  },
);

server.registerTool(
  "browser_visibility",
  {
    title: "Browser visibility",
    description: "Show, hide, toggle, or inspect the ChatGPT web backend browser window. Use show when ChatGPT needs sign-in or verification.",
    inputSchema: BrowserVisibilityInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (rawArgs): Promise<CallToolResult> => {
    const args = BrowserVisibilityInput.parse(rawArgs);
    try {
      const result = await backends["chatgpt-web"].browserVisibility({
        action: args.action,
        startBrowser: args.start_browser,
      });
      const structured = result as unknown as Record<string, unknown>;
      return {
        content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
      };
    } catch (error) {
      return errorResult(error);
    }
  },
);

server.registerTool(
  "collect_images",
  {
    title: "Collect images",
    description:
      "Save the most recent generated images from a ChatGPT conversation without sending a prompt. Use it when generate_image timed out but ChatGPT may still finish the image; the timeout error includes the conversation URL, and backend_status reports last_conversation_url.",
    inputSchema: CollectImagesInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (rawArgs, extra): Promise<CallToolResult> => {
    const args = CollectImagesInput.parse(rawArgs);
    const stopProgress = startProgress(extra as unknown as ToolExtra, "Collecting images");
    try {
      if (!isConversationUrl(args.conversation_url)) {
        throw new Error(`conversation_url must be a chatgpt.com conversation URL: ${args.conversation_url}`);
      }
      const result = await backends["chatgpt-web"].collect({
        conversationUrl: args.conversation_url,
        timeoutSeconds: args.timeout_seconds,
        maxImages: args.n,
        signal: extra.signal,
      });
      return await imageResultToToolResult(result, "chatgpt-web", args.return_images);
    } catch (error) {
      return errorResult(error);
    } finally {
      stopProgress();
    }
  },
);

server.registerTool(
  "list_generations",
  {
    title: "List generations",
    description: "List earlier saved generations (newest first) from the output folder, with prompt, backend, image paths, and conversation_url when available.",
    inputSchema: ListGenerationsInput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async (rawArgs): Promise<CallToolResult> => {
    const args = ListGenerationsInput.parse(rawArgs);
    const entries = await readdir(config.outputRoot, { withFileTypes: true }).catch(() => []);
    const generations: Record<string, unknown>[] = [];
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      if (generations.length >= args.limit) {
        break;
      }
      const outputDir = path.join(config.outputRoot, entry.name);
      const metadata = await readFile(path.join(outputDir, "metadata.json"), "utf8")
        .then((text) => JSON.parse(text) as Record<string, unknown>)
        .catch(() => undefined);
      if (!metadata) {
        continue;
      }
      const images = Array.isArray(metadata.images) ? (metadata.images as GeneratedImage[]).map((image) => image.path) : [];
      generations.push({
        output_dir: outputDir,
        prompt: metadata.prompt,
        backend: metadata.backend,
        created_at: metadata.created_at,
        images,
        conversation_url: metadata.conversation_url,
      });
    }
    const summary = { output_root: config.outputRoot, generations };
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      structuredContent: summary,
    };
  },
);

async function imageResultToToolResult(
  result: GenerateImageResult & { fallbackFrom?: string },
  requestedBackend: string,
  returnImages: "inline" | "none",
): Promise<CallToolResult> {
  const summary = {
    status: result.status,
    requested_backend: requestedBackend,
    backend: result.backend,
    fallback_from: result.fallbackFrom,
    prompt: result.prompt,
    output_dir: result.outputDir,
    image_path: result.primaryImage.path,
    images: result.images,
    conversation_url: result.metadata?.conversation_url,
    warnings: result.warnings ?? [],
    metadata: result.metadata,
  };

  const content: ContentBlock[] = [{ type: "text", text: JSON.stringify(summary, null, 2) }];
  if (returnImages === "inline") {
    for (const image of result.images) {
      content.push(await imageToContent(image));
    }
  }
  return {
    content,
    structuredContent: summary,
  };
}

async function imageToContent(image: GeneratedImage): Promise<ContentBlock> {
  return {
    type: "image",
    data: (await readFile(image.path)).toString("base64"),
    mimeType: image.mimeType,
  };
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  installShutdownHandlers();
  for (const warning of config.warnings) {
    console.error(`Warning: ${warning}`);
  }
  console.error(`gpt-image-2 MCP server ${PACKAGE_VERSION} running on stdio with default backend: ${config.defaultBackend}`);
  if (config.defaultBackend === "chatgpt-web" && config.web.eagerStart) {
    console.error("Starting ChatGPT web browser session (CHATGPT_WEB_EAGER_START). Complete login in the opened browser window if asked.");
    void backends["chatgpt-web"]
      .start()
      .then(() => {
        console.error("ChatGPT web browser session is ready. Tool calls can now generate images.");
      })
      .catch((error) => {
        console.error("ChatGPT web browser startup failed:", error);
      });
  }
}

function installShutdownHandlers(): void {
  const shutdown = (reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    setTimeout(() => process.exit(0), 5000).unref();
    void backends["chatgpt-web"]
      .close()
      .catch((error) => {
        console.error(`Failed to close ChatGPT browser during ${reason}:`, error);
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.stdin.once("close", () => shutdown("stdin close"));
  process.stdin.once("end", () => shutdown("stdin end"));
}

if (process.argv[2] === "import-chrome-cookies") {
  importChromeCookies(config).then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
} else {
  main().catch((error) => {
    console.error("Fatal error in gpt-image-2 MCP server:", error);
    process.exit(1);
  });
}
