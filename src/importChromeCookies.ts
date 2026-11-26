import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AppConfig } from "./config.js";
import { acquireProfile, launchProfileContext } from "./backends/chatgptWeb.js";

const COOKIE_DOMAIN = /(^|\.)(chatgpt\.com|openai\.com)$/i;

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export function defaultChromeUserDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const home = os.homedir();
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Google", "Chrome", "User Data");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Google", "Chrome");
  }
  return path.join(home, ".config", "google-chrome");
}

async function devToolsEndpoint(userDataDir: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path.join(userDataDir, "DevToolsActivePort"), "utf8");
  } catch {
    throw new Error(
      `Remote debugging is not enabled in the Chrome at ${userDataDir}. Open chrome://inspect/#remote-debugging in that Chrome, turn on "Allow remote debugging for this browser instance", then run this command again.`,
    );
  }
  const [port, wsPath] = text.trim().split(/\r?\n/);
  return `ws://127.0.0.1:${port}${wsPath}`;
}

async function readChromeCookies(endpoint: string): Promise<CdpCookie[]> {
  if (typeof WebSocket === "undefined") {
    throw new Error("import-chrome-cookies needs Node.js 22 or newer (global WebSocket).");
  }
  const socket = new WebSocket(endpoint);
  try {
    return await new Promise<CdpCookie[]>((resolve, reject) => {
      const fail = (message: string) => () => reject(new Error(message));
      const timer = setTimeout(fail("Timed out waiting for Chrome. Click Allow on Chrome's remote debugging prompt, then run this command again."), 60_000);
      socket.addEventListener("error", fail("Could not connect to Chrome's remote debugging port. Make sure remote debugging is still enabled and click Allow on Chrome's prompt."), { once: true });
      socket.addEventListener("close", fail("Chrome closed the remote debugging connection, possibly because the prompt was declined."), { once: true });
      socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Storage.getCookies" })), { once: true });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: { cookies: CdpCookie[] }; error?: { message: string } };
        if (message.id !== 1) {
          return;
        }
        clearTimeout(timer);
        if (message.result) {
          resolve(message.result.cookies);
        } else {
          reject(new Error(`Chrome refused Storage.getCookies: ${message.error?.message ?? "unknown error"}`));
        }
      });
    });
  } finally {
    socket.close();
  }
}

export async function importChromeCookies(config: AppConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const userDataDir = env.CHROME_USER_DATA_DIR || defaultChromeUserDataDir(env);
  const cookies = (await readChromeCookies(await devToolsEndpoint(userDataDir))).filter((cookie) => COOKIE_DOMAIN.test(cookie.domain));
  if (!cookies.some((cookie) => cookie.name.startsWith("__Secure-next-auth.session-token"))) {
    throw new Error("No ChatGPT session cookie found in that Chrome. Sign in at https://chatgpt.com/ in that Chrome first.");
  }

  const context = await acquireProfile(
    config.web.profileDir,
    Date.now() + 60_000,
    undefined,
    () => launchProfileContext(config.web.profileDir, true),
    () => new Error("Timed out opening the MCP browser profile."),
  );
  let verified = false;
  try {
    await context.addCookies(
      cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite ?? "Lax",
      })),
    );
    const session = await context.request
      .get("https://chatgpt.com/api/auth/session")
      .then(async (response) => (response.ok() ? ((await response.json()) as { user?: unknown }) : undefined))
      .catch(() => undefined);
    verified = Boolean(session?.user);
  } finally {
    await context.close();
  }
  console.error(`Imported ${cookies.length} chatgpt.com/openai.com cookies from ${userDataDir} into ${config.web.profileDir}.`);
  console.error(verified ? "Verified: the imported session is signed in to ChatGPT." : "Could not verify the ChatGPT sign-in from the command line; the first generate_image call will check it.");
}
