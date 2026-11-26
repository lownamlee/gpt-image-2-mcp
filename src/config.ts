import os from "node:os";
import path from "node:path";

import { z } from "zod";

export const BackendSelectionSchema = z.enum(["api", "chatgpt-web", "auto"]);
export type BackendSelection = z.infer<typeof BackendSelectionSchema>;

export const BackendNameSchema = z.enum(["api", "chatgpt-web"]);
export type BackendName = z.infer<typeof BackendNameSchema>;

export const ConversationModeSchema = z.enum(["new", "continue"]);
export type ConversationMode = z.infer<typeof ConversationModeSchema>;

export const OutputFormatSchema = z.enum(["png", "jpeg", "webp"]);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;

export const ImageQualitySchema = z.enum(["low", "medium", "high", "auto"]);
export type ImageQuality = z.infer<typeof ImageQualitySchema>;

const APP_DIRECTORY_NAME = "gpt-image-2-mcp";

export function defaultAppDataRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const home = os.homedir();
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || env.APPDATA || path.join(home, "AppData", "Local"), APP_DIRECTORY_NAME);
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", APP_DIRECTORY_NAME);
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), APP_DIRECTORY_NAME);
}

export function defaultOutputRoot(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  return path.join(defaultAppDataRoot(env, platform), "output", "chatgpt-images");
}

export function defaultProfileDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  return path.join(defaultAppDataRoot(env, platform), "profile");
}

export interface AppConfig {
  defaultBackend: BackendSelection;
  outputRoot: string;
  warnings: string[];
  api: {
    apiKey?: string;
    model: string;
  };
  web: {
    profileDir: string;
    loginTimeoutSeconds: number;
    hideWindow: boolean;
    eagerStart: boolean;
    idleCloseSeconds: number;
  };
}

function parseBackend(value: string | undefined, warnings: string[]): BackendSelection {
  const parsed = BackendSelectionSchema.safeParse(value || "api");
  if (!parsed.success) {
    warnings.push(`GPT_IMAGE_BACKEND="${value}" is not one of api, chatgpt-web, auto; using api.`);
    return "api";
  }
  return parsed.data;
}


const MAX_TIMER_SECONDS = 2_147_483;

function parseInteger(name: string, value: string | undefined, fallback: number, minimum: number, warnings: string[]): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > MAX_TIMER_SECONDS) {
    warnings.push(`${name}="${value}" is not a whole number from ${minimum} to ${MAX_TIMER_SECONDS}; using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean, warnings: string[]): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  warnings.push(`${name}="${value}" is not one of 1, 0, true, false, yes, no, on, off; using ${fallback ? "1" : "0"}.`);
  return fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const warnings: string[] = [];
  return {
    defaultBackend: parseBackend(env.GPT_IMAGE_BACKEND, warnings),
    outputRoot: path.resolve(env.GPT_IMAGE_OUTPUT_DIR || defaultOutputRoot(env)),
    warnings,
    api: {
      apiKey: env.OPENAI_API_KEY,
      model: env.GPT_IMAGE_MODEL || "gpt-image-2",
    },
    web: {
      profileDir: path.resolve(env.CHATGPT_WEB_PROFILE_DIR || defaultProfileDir(env)),
      loginTimeoutSeconds: parseInteger("CHATGPT_WEB_LOGIN_TIMEOUT_SECONDS", env.CHATGPT_WEB_LOGIN_TIMEOUT_SECONDS, 900, 1, warnings),
      hideWindow: parseBoolean("CHATGPT_HIDE_WINDOW", env.CHATGPT_HIDE_WINDOW, true, warnings),
      eagerStart: parseBoolean("CHATGPT_WEB_EAGER_START", env.CHATGPT_WEB_EAGER_START, false, warnings),
      idleCloseSeconds: parseInteger("CHATGPT_WEB_IDLE_CLOSE_SECONDS", env.CHATGPT_WEB_IDLE_CLOSE_SECONDS, 600, 0, warnings),
    },
  };
}
