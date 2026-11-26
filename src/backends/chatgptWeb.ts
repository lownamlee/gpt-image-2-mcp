import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { chromium, type BrowserContext, type Page } from "patchright";

import type { AppConfig } from "../config.js";
import { createOutputDir, writeBase64Image, writeMetadata } from "../output.js";
import { BackendUnavailableError, type BackendStatus, type GenerateImageArgs, type GenerateImageResult, type GeneratedImage, type ImageBackend } from "./types.js";

const CHATGPT_URL = "https://chatgpt.com/";
const HIDDEN_WINDOW_LEFT = -32000;
const HIDDEN_WINDOW_TOP = -32000;
const HIDDEN_WINDOW_WIDTH = 1440;
const HIDDEN_WINDOW_HEIGHT = 960;
const VISIBLE_WINDOW_LEFT = 80;
const VISIBLE_WINDOW_TOP = 80;
const VISIBLE_WINDOW_WIDTH = 1280;
const VISIBLE_WINDOW_HEIGHT = 900;
const execFileAsync = promisify(execFile);

interface PageState {
  title: string;
  url: string;
  challenge?: boolean;
}

interface BrowserImage {
  src: string;
  alt: string;
  naturalWidth: number;
  naturalHeight: number;
  displayWidth: number;
  displayHeight: number;
}

interface ChatPageReadiness {
  ready: boolean;
  hideReady: boolean;
  composerSelector?: string;
  state?: PageState;
  reason?: string;
  hideReason?: string;
}

interface BrowserHideResult {
  hidden: boolean;
  method?: "offscreen" | "minimized";
  bounds?: Record<string, unknown>;
  previousBounds?: Record<string, unknown>;
  error?: string;
}

interface BrowserShowResult {
  visible: boolean;
  method?: "window-bounds" | "bring-to-front";
  bounds?: Record<string, unknown>;
  error?: string;
}

interface BrowserProfileOwner {
  pid: number;
  processName: string;
}

export type BrowserVisibilityAction = "show" | "hide" | "toggle" | "status";

export interface BrowserVisibilityOptions {
  action: BrowserVisibilityAction;
  startBrowser: boolean;
}

export interface BrowserVisibilityStatus {
  backend: "chatgpt-web";
  mode: "direct";
  supported: boolean;
  requested_action: BrowserVisibilityAction;
  applied_action?: Exclude<BrowserVisibilityAction, "status" | "toggle">;
  default_hide_window: boolean;
  hide_window: boolean;
  browser_open: boolean;
  chat_ready: boolean;
  hide_ready: boolean;
  hidden: boolean;
  visible: boolean;
  hide_attempted: boolean;
  hide_method?: string;
  hide_error?: string;
  show_method?: string;
  show_error?: string;
  current_url?: string;
  message: string;
}

interface DirectSessionStatus {
  ready: boolean;
  starting: boolean;
  mode: "direct-typescript-browser";
  session_reused: boolean;
  profile_dir: string;
  browser_open: boolean;
  chat_ready: boolean;
  hide_ready: boolean;
  default_hide_window: boolean;
  hide_window: boolean;
  hidden: boolean;
  hide_attempted: boolean;
  hide_method?: string;
  hide_error?: string;
  current_url?: string;
  last_conversation_url?: string;
  last_error?: string;
}

export class ChatGptWebBackend implements ImageBackend {
  readonly name = "chatgpt-web" as const;
  private readonly directSession: DirectChatGptBrowserSession;

  constructor(private readonly config: AppConfig) {
    this.directSession = new DirectChatGptBrowserSession(config);
  }

  start(): Promise<void> {
    return this.directSession.start();
  }

  async status(): Promise<BackendStatus> {
    const session = await this.directSession.status();
    return {
      backend: this.name,
      configured: true,
      ready: session.ready,
      message: directStatusMessage(session),
      details: {
        mode: "direct",
        output_root: this.config.outputRoot,
        profile_dir: this.config.web.profileDir,
        default_hide_window: this.config.web.hideWindow,
        hide_window: session.hide_window,
        login_timeout_seconds: this.config.web.loginTimeoutSeconds,
        session,
      },
    };
  }

  async generateImage(args: GenerateImageArgs): Promise<GenerateImageResult> {
    return this.directSession.generate({
      prompt: args.prompt,
      timeoutSeconds: args.timeoutSeconds,
      maxImages: args.n,
      conversationMode: args.conversationMode,
      conversationUrl: args.conversationUrl,
      referenceImages: args.referenceImages,
      signal: args.signal,
    });
  }

  collect(params: { conversationUrl: string; timeoutSeconds: number; maxImages: number; signal?: AbortSignal }): Promise<GenerateImageResult> {
    return this.directSession.collect(params);
  }

  async close(): Promise<void> {
    await this.directSession.close();
  }

  async browserVisibility(options: BrowserVisibilityOptions): Promise<BrowserVisibilityStatus> {
    return this.directSession.browserVisibility(options);
  }
}

class DirectChatGptBrowserSession {
  private context?: BrowserContext;
  private page?: Page;
  private lock = Promise.resolve();
  private startup?: Promise<void>;
  private lastError?: string;
  private chatReady = false;
  private hideReady = false;
  private hideWindowEnabled: boolean;
  private hidden = false;
  private hideAttempted = false;
  private hideMethod?: string;
  private hideError?: string;
  private showMethod?: string;
  private showError?: string;
  private lastVisibleBounds?: Record<string, unknown>;
  private blankPageCleanupContext?: BrowserContext;
  private busy = false;
  private idleTimer?: NodeJS.Timeout;
  private releaseWatcher?: NodeJS.Timeout;
  private launchedAt = 0;
  private lastConversationUrl?: string;
  private lastReadinessReason?: string;

  constructor(private readonly config: AppConfig) {
    this.hideWindowEnabled = config.web.hideWindow;
  }

  private get browserOpen(): boolean {
    return Boolean(this.page && !this.page.isClosed());
  }

  get ready(): boolean {
    return this.browserOpen && this.chatReady;
  }

  async status(): Promise<DirectSessionStatus> {
    if (this.browserOpen && !this.startup && !this.busy) {
      try {
        await this.refreshChatReadiness("status");
      } catch (error) {
        this.chatReady = false;
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      ready: this.ready,
      starting: Boolean(this.startup),
      mode: "direct-typescript-browser",
      session_reused: this.browserOpen,
      profile_dir: this.config.web.profileDir,
      browser_open: this.browserOpen,
      chat_ready: this.chatReady,
      hide_ready: this.hideReady,
      default_hide_window: this.config.web.hideWindow,
      hide_window: this.hideWindowEnabled,
      hidden: this.hidden,
      hide_attempted: this.hideAttempted,
      hide_method: this.hideMethod,
      hide_error: this.hideError,
      current_url: this.browserOpen ? safePageUrl(this.page) : undefined,
      last_conversation_url: this.lastConversationUrl,
      last_error: this.lastError,
    };
  }

  start(): Promise<void> {
    if (this.ready) {
      void this.hideWindowIfConfigured("already-ready").catch((error) => {
        this.hideError = error instanceof Error ? error.message : String(error);
      });
      return Promise.resolve();
    }
    if (!this.startup) {
      this.lastError = undefined;
      const startup: Promise<void> = this.ensureStarted()
        .catch((error) => {
          if (this.startup === startup) {
            this.lastError = error instanceof Error ? error.message : String(error);
          }
          throw error;
        })
        .finally(() => {
          if (this.startup === startup) {
            this.startup = undefined;
          }
          this.scheduleIdleClose();
        });
      this.startup = startup;
    }
    return this.startup;
  }

  async browserVisibility(options: BrowserVisibilityOptions): Promise<BrowserVisibilityStatus> {
    {
      const requestedAction = options.action;
      let appliedAction: "show" | "hide" | undefined;
      let message = "Browser visibility status returned.";

      if (requestedAction === "toggle") {
        appliedAction = this.hidden ? "show" : "hide";
      } else if (requestedAction === "show" || requestedAction === "hide") {
        appliedAction = requestedAction;
      }

      if (appliedAction === "show") {
        this.hideWindowEnabled = false;
        if (!this.browserOpen && options.startBrowser) {
          await this.openBrowserWithoutWaitingForSignIn();
        }
        if (this.browserOpen && this.page) {
          await this.showBrowserWindow();
          message = this.hidden ? "Browser show was requested, but the browser could not be restored." : "Browser window is visible.";
        } else {
          message = "Browser will remain visible when the ChatGPT web session starts.";
        }
      } else if (appliedAction === "hide") {
        this.hideWindowEnabled = true;
        if (!this.browserOpen && options.startBrowser) {
          await this.openBrowserWithoutWaitingForSignIn();
        } else if (this.browserOpen && this.page) {
          if (!this.busy) {
            await this.refreshChatReadiness("visibility-hide");
          }
          if (this.hideReady) {
            await this.hideWindowIfConfigured("visibility-hide");
          }
        }

        if (!this.browserOpen) {
          message = "Browser will hide after the ChatGPT web session starts and reaches the composer page.";
        } else if (!this.hideReady) {
          message = "Browser will hide after ChatGPT login or verification reaches the composer page.";
        } else if (this.hidden) {
          message = "Browser window is hidden.";
        } else {
          message = "Browser hide was requested, but the browser could not be hidden.";
        }
      } else if (!this.browserOpen && options.startBrowser) {
        await this.openBrowserWithoutWaitingForSignIn();
        message = "Browser started.";
      } else if (this.browserOpen && !this.busy) {
        await this.refreshChatReadiness("visibility-status");
      }

      if (this.browserOpen && this.startup) {
        message = `${message} Waiting for ChatGPT sign-in in the browser window.`;
      }
      if (this.browserOpen && !this.busy) {
        this.scheduleIdleClose();
      }
      return this.visibilityStatus(requestedAction, appliedAction, message);
    }
  }

  private async openBrowserWithoutWaitingForSignIn(): Promise<void> {
    const deadline = Date.now() + 30_000;
    await acquireProfile(
      this.config.web.profileDir,
      deadline,
      undefined,
      async () => {
        const startup = this.start();
        let settled = false;
        startup.then(
          () => (settled = true),
          () => (settled = true),
        );
        while (!this.browserOpen && !settled && Date.now() < deadline) {
          await sleep(250);
        }
        if (settled) {
          await startup;
        }
      },
      () => new Error("Timed out opening the ChatGPT browser window."),
    );
  }

  async generate(params: {
    prompt: string;
    timeoutSeconds: number;
    maxImages: number;
    conversationMode: "new" | "continue";
    conversationUrl?: string;
    referenceImages?: string[];
    signal?: AbortSignal;
  }): Promise<GenerateImageResult> {
    const deadline = Date.now() + params.timeoutSeconds * 1000;
    return this.withReadyPage(deadline, params.signal, async (page) => {
      const conversationUrl =
        params.conversationUrl ??
        (params.conversationMode === "continue" && !isConversationUrl(safePageUrl(page)) ? this.lastConversationUrl : undefined);
      try {
        return await sendPromptAndExport(page, this.config, {
          prompt: params.prompt,
          deadline,
          maxImages: params.maxImages,
          conversationMode: params.conversationMode,
          conversationUrl,
          referenceImages: params.referenceImages,
          signal: params.signal,
          onBlocked: () => this.revealForVerification(),
        });
      } finally {
        const url = safePageUrl(page);
        if (isConversationUrl(url)) {
          this.lastConversationUrl = url;
        }
      }
    });
  }

  async collect(params: { conversationUrl: string; timeoutSeconds: number; maxImages: number; signal?: AbortSignal }): Promise<GenerateImageResult> {
    const deadline = Date.now() + params.timeoutSeconds * 1000;
    return this.withReadyPage(deadline, params.signal, (page) =>
      collectConversationImages(page, this.config, {
        conversationUrl: params.conversationUrl,
        deadline,
        maxImages: params.maxImages,
        signal: params.signal,
        onBlocked: () => this.revealForVerification(),
      }),
    );
  }

  private async revealForVerification(): Promise<void> {
    this.hideReady = false;
    if (this.hidden) {
      await this.showBrowserWindow();
    }
  }

  private async withReadyPage<T>(deadline: number, signal: AbortSignal | undefined, task: (page: Page) => Promise<T>): Promise<T> {
    this.cancelIdleClose();
    return this.runExclusive(signal, deadline, async () => {
      this.busy = true;
      try {
        await this.startWaitingForProfile(deadline, signal);
        const page = this.page;
        if (!page) {
          throw new BackendUnavailableError("ChatGPT browser session did not start.", "chatgpt-web");
        }
        await this.waitForComposerWithHide(page, deadline, "before-generate", signal);
        await this.hideWindowIfConfigured("before-generate");
        return await task(page);
      } finally {
        this.busy = false;
        await this.refreshChatReadiness("after-generate").catch(() => undefined);
        this.scheduleIdleClose();
      }
    });
  }

  private async startWaitingForProfile(deadline: number, signal: AbortSignal | undefined): Promise<void> {
    await acquireProfile(
      this.config.web.profileDir,
      deadline,
      signal,
      () => this.start(),
      () =>
        this.lastReadinessReason === "verification-or-security-check"
          ? new LoginRequiredError("ChatGPT is showing a verification check. Complete it in the ChatGPT browser window (browser_visibility show displays it), then call again.")
          : new LoginRequiredError("ChatGPT is not signed in yet. Sign in in the opened browser window, or run import-chrome-cookies, then call generate_image again."),
    );
  }

  private cancelIdleClose(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private scheduleIdleClose(): void {
    this.cancelIdleClose();
    if (this.config.web.idleCloseSeconds <= 0 || !this.context) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      if (this.busy || this.startup) {
        this.scheduleIdleClose();
        return;
      }
      console.error(`Closing idle ChatGPT browser after ${this.config.web.idleCloseSeconds}s.`);
      void this.close();
    }, this.config.web.idleCloseSeconds * 1000);
    this.idleTimer.unref?.();
  }

  private watchReleaseRequests(): void {
    clearInterval(this.releaseWatcher);
    const releaseFile = releaseRequestPath(this.config.web.profileDir);
    const ackFile = releaseAckPath(this.config.web.profileDir);
    this.releaseWatcher = setInterval(() => {
      if (!this.context) {
        return;
      }
      void stat(releaseFile)
        .then(async (info) => {
          if (info.mtimeMs < this.launchedAt || Date.now() - info.mtimeMs > RELEASE_REQUEST_FRESH_MS) {
            return;
          }
          await writeFile(ackFile, String(Date.now())).catch(() => undefined);
          if (this.busy) {
            return;
          }
          await rm(releaseFile, { force: true });
          if (this.busy || !this.context) {
            return;
          }
          console.error("Closing ChatGPT browser so another gpt-image-2 MCP session can use the profile.");
          await this.close();
        })
        .catch(() => undefined);
    }, 1000);
    this.releaseWatcher.unref?.();
  }

  async close(): Promise<void> {
    this.cancelIdleClose();
    clearInterval(this.releaseWatcher);
    this.releaseWatcher = undefined;
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    this.chatReady = false;
    this.hideReady = false;
    this.hidden = false;
    this.hideWindowEnabled = this.config.web.hideWindow;
    this.lastReadinessReason = undefined;
    this.startup = undefined;
    this.blankPageCleanupContext = undefined;
    if (context) {
      try {
        await context.close();
      } catch {
        // Shutdown should be best-effort; the process may already be exiting.
      }
    }
  }

  private async runExclusive<T>(signal: AbortSignal | undefined, deadline: number, task: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    this.lock = previous.then(() => mine);
    const queuedAt = Date.now();
    try {
      await raceDeadline(
        previous,
        deadline,
        signal,
        () => new Error(`Timed out after ${Math.round((Date.now() - queuedAt) / 1000)}s waiting for another image generation in this session to finish.`),
      );
      throwIfAborted(signal);
      return await task();
    } finally {
      release();
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.ready) {
      await this.hideWindowIfConfigured("already-started");
      return;
    }

    if (!this.browserOpen && this.context) {
      try {
        this.page = watchForCrash(await this.context.newPage());
      } catch {
        const stale = this.context;
        this.context = undefined;
        this.page = undefined;
        await stale.close().catch(() => undefined);
      }
    }

    if (!this.browserOpen) {
      this.context = await launchProfileContext(this.config.web.profileDir);
      this.launchedAt = Date.now();
      await rm(releaseRequestPath(this.config.web.profileDir), { force: true }).catch(() => undefined);
      this.watchReleaseRequests();

      this.page = watchForCrash((await selectStartupPage(this.context)) || (await this.context.newPage()));
      this.installBlankPageCleanup(this.context);
      this.scheduleBlankPageCleanup("startup");
      this.hidden = false;
      this.hideAttempted = false;
      this.hideMethod = undefined;
      this.hideError = undefined;
      this.hideReady = false;
      this.chatReady = false;
    }

    const page = this.page;
    if (!page) {
      throw new BackendUnavailableError("TypeScript ChatGPT browser page was not created.", "chatgpt-web");
    }

    page.setDefaultTimeout(30_000);
    await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(2500);
    await this.closeExtraBlankPages("post-navigation");
    const readiness = await this.refreshChatReadiness("post-navigation");

    if (!readiness?.hideReady) {
      console.error("ChatGPT browser opened. Log in or complete verification in that browser window.");
      console.error("The MCP server will hide the browser after chatgpt.com shows a signed-in ChatGPT page.");
    }

    await this.waitForComposerWithHide(page, Date.now() + this.config.web.loginTimeoutSeconds * 1000, "startup");
    await this.closeExtraBlankPages("composer-ready");
    await this.hideWindowIfConfigured("login-complete");
  }

  private installBlankPageCleanup(context: BrowserContext): void {
    if (this.blankPageCleanupContext === context) {
      return;
    }
    this.blankPageCleanupContext = context;
    context.on("page", () => {
      this.scheduleBlankPageCleanup("new-page");
    });
  }

  private scheduleBlankPageCleanup(reason: string): void {
    for (const delay of [250, 1500, 5000, 15_000, 30_000]) {
      const timer = setTimeout(() => {
        void this.closeExtraBlankPages(reason).catch(() => undefined);
      }, delay);
      timer.unref?.();
    }
  }

  private async closeExtraBlankPages(reason: string): Promise<void> {
    if (!this.context || !this.page || this.page.isClosed()) {
      return;
    }
    try {
      await closeExtraBlankPages(this.context, this.page);
    } catch (error) {
      console.error(`Failed to close extra blank ChatGPT browser tabs during ${reason}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async waitForComposerWithHide(page: Page, deadline: number, reason: string, signal?: AbortSignal): Promise<string> {
    let lastReadiness: ChatPageReadiness | undefined;
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      try {
        await this.closeExtraBlankPages(`${reason}-poll`);
        lastReadiness = await chatPageReadiness(page);
        this.chatReady = lastReadiness.ready;
        this.hideReady = lastReadiness.hideReady;
        this.lastReadinessReason = lastReadiness.reason;
        if (lastReadiness.hideReady) {
          await this.hideWindowIfConfigured(lastReadiness.hideReason || reason);
        } else if (this.hidden) {
          await this.showBrowserWindow();
        }
        if (lastReadiness.ready && lastReadiness.composerSelector) {
          return lastReadiness.composerSelector;
        }
      } catch {
        lastReadiness = undefined;
      }
      await page.waitForTimeout(2000);
    }

    if (lastReadiness?.state && looksBlocked(lastReadiness.state)) {
      throw new LoginRequiredError("Timed out waiting for ChatGPT verification. Complete verification/login faster, then run the command again.");
    }
    const detail = lastReadiness?.reason ? ` Last observed state: ${lastReadiness.reason}.` : "";
    throw new LoginRequiredError(`Timed out waiting for a signed-in ChatGPT page. Sign in in the opened browser window, or run import-chrome-cookies, then call again.${detail}`);
  }

  private async refreshChatReadiness(reason: string): Promise<ChatPageReadiness | undefined> {
    if (!this.browserOpen || !this.page) {
      this.chatReady = false;
      this.hideReady = false;
      this.hidden = false;
      return undefined;
    }

    let readiness: ChatPageReadiness;
    try {
      readiness = await chatPageReadiness(this.page);
    } catch {
      this.chatReady = false;
      return undefined;
    }
    this.chatReady = readiness.ready;
    this.hideReady = readiness.hideReady;
    if (readiness.hideReady) {
      await this.hideWindowIfConfigured(reason);
    }
    return readiness;
  }

  private async hideWindowIfConfigured(reason: string): Promise<void> {
    if (!this.hideWindowEnabled || !this.hideReady || !this.page || this.page.isClosed() || this.hidden) {
      return;
    }

    this.hideAttempted = true;
    const result = await hideBrowserWindow(this.page);
    this.hidden = result.hidden;
    this.hideMethod = result.method;
    this.hideError = result.error;
    if (result.previousBounds && !hiddenBounds(result.previousBounds)) {
      this.lastVisibleBounds = result.previousBounds;
    }

    if (result.hidden) {
      console.error(`ChatGPT browser hidden after ${reason} using ${result.method}.`);
      return;
    }
    if (result.error) {
      console.error(`ChatGPT browser hide failed after ${reason}: ${result.error}`);
    }
  }

  private async showBrowserWindow(): Promise<void> {
    if (!this.page || this.page.isClosed()) {
      return;
    }

    const result = await showBrowserWindow(this.page, this.lastVisibleBounds);
    this.hidden = !result.visible;
    this.showMethod = result.method;
    this.showError = result.error;
    if (result.bounds && !hiddenBounds(result.bounds)) {
      this.lastVisibleBounds = result.bounds;
    }
    if (result.visible) {
      this.hideMethod = undefined;
      this.hideError = undefined;
    }
  }

  private visibilityStatus(
    requestedAction: BrowserVisibilityAction,
    appliedAction: "show" | "hide" | undefined,
    message: string,
  ): BrowserVisibilityStatus {
    return {
      backend: "chatgpt-web",
      mode: "direct",
      supported: true,
      requested_action: requestedAction,
      applied_action: appliedAction,
      default_hide_window: this.config.web.hideWindow,
      hide_window: this.hideWindowEnabled,
      browser_open: this.browserOpen,
      chat_ready: this.chatReady,
      hide_ready: this.hideReady,
      hidden: this.hidden,
      visible: this.browserOpen && !this.hidden,
      hide_attempted: this.hideAttempted,
      hide_method: this.hideMethod,
      hide_error: this.hideError,
      show_method: this.showMethod,
      show_error: this.showError,
      current_url: this.browserOpen ? safePageUrl(this.page) : undefined,
      message,
    };
  }
}

function directStatusMessage(session: DirectSessionStatus): string {
  if (session.ready) {
    return "TypeScript ChatGPT browser session is ready.";
  }
  if (session.starting) {
    return "TypeScript ChatGPT browser is starting. Complete ChatGPT login or verification in the opened browser window.";
  }
  if (session.last_error) {
    return `TypeScript ChatGPT browser startup failed: ${session.last_error}`;
  }
  return "TypeScript ChatGPT browser automation is configured but has not started.";
}

export class ProfileInUseError extends BackendUnavailableError {
  final = false;
}

const PROFILE_RETRY_MS = 3000;
const RELEASE_REQUEST_FRESH_MS = 10_000;
const RELEASE_ACK_TIMEOUT_MS = 10_000;
const PROFILE_MIN_ATTEMPT_MS = 5000;

function releaseRequestPath(profileDir: string): string {
  return `${profileDir}.release-request`;
}

function releaseAckPath(profileDir: string): string {
  return `${profileDir}.release-ack`;
}

export async function acquireProfile<T>(
  profileDir: string,
  deadline: number,
  signal: AbortSignal | undefined,
  attempt: () => Promise<T>,
  onTimeout: () => Error,
): Promise<T> {
  const releaseFile = releaseRequestPath(profileDir);
  const started = Date.now();
  let requestedAt: number | undefined;
  let lastProfileError: ProfileInUseError | undefined;
  const waited = (error: ProfileInUseError) => {
    const final = new ProfileInUseError(`Waited ${Math.round((Date.now() - started) / 1000)}s for the ChatGPT browser profile. ${error.message}`, "chatgpt-web");
    final.final = true;
    return final;
  };
  try {
    for (;;) {
      try {
        return await raceDeadline(attempt(), deadline, signal, onTimeout);
      } catch (error) {
        if (!(error instanceof ProfileInUseError) || error.final) {
          throw error;
        }
        lastProfileError = error;
        if (requestedAt !== undefined && Date.now() - requestedAt > RELEASE_ACK_TIMEOUT_MS) {
          const ack = await stat(releaseAckPath(profileDir)).catch(() => undefined);
          if (!ack || ack.mtimeMs < requestedAt) {
            throw new ProfileInUseError(
              `The ChatGPT browser profile is held by a program that did not answer the gpt-image-2 hand-off request, so it is not an idle gpt-image-2 session (or it is a gpt-image-2 server started before an update; restart that client). Close the program using the profile, then call again. ${error.message}`,
              "chatgpt-web",
            );
          }
        }
        if (Date.now() + PROFILE_RETRY_MS >= deadline) {
          throw waited(error);
        }
        requestedAt ??= Date.now();
        await writeFile(releaseFile, String(Date.now())).catch(() => undefined);
        await raceDeadline(sleep(PROFILE_RETRY_MS), deadline, signal, () => waited(error));
        if (deadline - Date.now() < PROFILE_MIN_ATTEMPT_MS) {
          throw waited(error);
        }
      }
    }
  } finally {
    if (requestedAt !== undefined) {
      await rm(releaseFile, { force: true }).catch(() => undefined);
    }
  }
}

function watchForCrash(page: Page): Page {
  page.on("crash", () => {
    console.error("The ChatGPT tab crashed; the next call opens a new tab.");
    void page.close().catch(() => undefined);
  });
  return page;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LoginRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginRequiredError";
  }
}

class ImageGenerationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageGenerationRefusedError";
  }
}

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  throw new BackendUnavailableError("Chrome or Edge executable not found. Set CHROME_PATH to the browser executable.", "chatgpt-web");
}

export async function launchProfileContext(profileDir: string, headless = false): Promise<BrowserContext> {
  await mkdir(profileDir, { recursive: true });
  const profileOwner = await findBrowserProfileOwner(profileDir);
  if (profileOwner) {
    throw profileAlreadyOpenError(profileDir, profileOwner);
  }
  const commonOptions = {
    headless,
    chromiumSandbox: true,
    acceptDownloads: true,
    viewport: null,
    ignoreDefaultArgs: ["about:blank"],
  };

  try {
    return await chromium.launchPersistentContext(profileDir, {
      ...commonOptions,
      channel: "chrome",
    });
  } catch (error) {
    const owner = await findBrowserProfileOwner(profileDir);
    if (owner || isExistingBrowserSessionError(error)) {
      throw profileAlreadyOpenError(profileDir, owner);
    }
    try {
      return await chromium.launchPersistentContext(profileDir, {
        ...commonOptions,
        executablePath: findChrome(),
      });
    } catch (fallbackError) {
      const fallbackOwner = await findBrowserProfileOwner(profileDir);
      if (fallbackOwner || isExistingBrowserSessionError(fallbackError)) {
        throw profileAlreadyOpenError(profileDir, fallbackOwner);
      }
      throw fallbackError;
    }
  }
}

async function findBrowserProfileOwner(profileDir: string): Promise<BrowserProfileOwner | undefined> {
  if (process.platform !== "win32") {
    return undefined;
  }

  const script = `
$ErrorActionPreference = 'Stop'
$profileDir = [System.IO.Path]::GetFullPath($env:CHATGPT_WEB_PROFILE_OWNER_DIR).TrimEnd('\\').ToLowerInvariant()
$owner = Get-CimInstance Win32_Process -Filter "name = 'chrome.exe' OR name = 'msedge.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant() -match ('--user-data-dir="?' + [regex]::Escape($profileDir) + '\\\\?("|\\s|$)') } |
  Sort-Object @{ Expression = { if ($_.CommandLine -match '\\s--type=') { 1 } else { 0 } } }, ProcessId |
  Select-Object -First 1 @{ Name = 'pid'; Expression = { $_.ProcessId } }, @{ Name = 'processName'; Expression = { $_.Name } }
if ($owner) { $owner | ConvertTo-Json -Compress }
`;

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CHATGPT_WEB_PROFILE_OWNER_DIR: profileDir,
        },
        timeout: 5000,
        windowsHide: true,
      },
    );
    const trimmed = stdout.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = JSON.parse(trimmed) as Partial<BrowserProfileOwner>;
    return typeof parsed.pid === "number" && typeof parsed.processName === "string" ? { pid: parsed.pid, processName: parsed.processName } : undefined;
  } catch {
    return undefined;
  }
}

function profileAlreadyOpenError(profileDir: string, owner?: BrowserProfileOwner): BackendUnavailableError {
  const ownerText = owner ? `${owner.processName} PID ${owner.pid}` : "another Chrome or Edge process";
  return new ProfileInUseError(
    `The ChatGPT browser profile is already open in ${ownerText}, usually another gpt-image-2 MCP session from another client. A gpt-image-2 session hands the profile over when it is not generating; any other program using the profile has to be closed. Profile: ${profileDir}`,
    "chatgpt-web",
  );
}

function isExistingBrowserSessionError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /Opening in existing browser session/i.test(text);
}

function isChatGptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return hostname === "chatgpt.com" || hostname === "www.chatgpt.com";
  } catch {
    return false;
  }
}

function isBlankStartupUrl(value: string): boolean {
  return value === "about:blank" || value.startsWith("chrome://new-tab") || value.startsWith("edge://new-tab");
}

function safePageUrl(page?: Page): string {
  if (!page || page.isClosed()) {
    return "";
  }
  try {
    return page.url();
  } catch {
    return "";
  }
}

async function selectStartupPage(context: BrowserContext): Promise<Page | undefined> {
  const pages = context.pages().filter((page) => !page.isClosed());
  return pages.find((page) => isChatGptUrl(safePageUrl(page))) || pages.find((page) => isBlankStartupUrl(safePageUrl(page))) || pages[0];
}

async function closeExtraBlankPages(context: BrowserContext, keepPage: Page): Promise<void> {
  await Promise.all(
    context
      .pages()
      .filter((page) => page !== keepPage && !page.isClosed() && isBlankStartupUrl(safePageUrl(page)))
      .map(async (page) => {
        try {
          await page.close();
        } catch {
          // Blank startup tabs are cosmetic; failing to close one should not block login or generation.
        }
      }),
  );
}

function hiddenBounds(bounds?: Record<string, unknown>): boolean {
  if (!bounds) {
    return false;
  }
  return bounds.windowState === "minimized" || (typeof bounds.left === "number" && bounds.left <= -10_000);
}

function visibleWindowBounds(previousBounds?: Record<string, unknown>): Record<string, unknown> {
  const left = typeof previousBounds?.left === "number" && previousBounds.left > -10_000 ? previousBounds.left : VISIBLE_WINDOW_LEFT;
  const top = typeof previousBounds?.top === "number" && previousBounds.top > -10_000 ? previousBounds.top : VISIBLE_WINDOW_TOP;
  const width = typeof previousBounds?.width === "number" && previousBounds.width >= 640 ? previousBounds.width : VISIBLE_WINDOW_WIDTH;
  const height = typeof previousBounds?.height === "number" && previousBounds.height >= 480 ? previousBounds.height : VISIBLE_WINDOW_HEIGHT;
  return { left, top, width, height };
}

async function hideBrowserWindow(page: Page): Promise<BrowserHideResult> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const targetWindow = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
    const before = (await cdp.send("Browser.getWindowBounds", { windowId: targetWindow.windowId })) as { bounds?: Record<string, unknown> };
    await cdp.send("Browser.setWindowBounds", {
      windowId: targetWindow.windowId,
      bounds: { windowState: "normal" },
    });
    await cdp.send("Browser.setWindowBounds", {
      windowId: targetWindow.windowId,
      bounds: {
        left: HIDDEN_WINDOW_LEFT,
        top: HIDDEN_WINDOW_TOP,
        width: HIDDEN_WINDOW_WIDTH,
        height: HIDDEN_WINDOW_HEIGHT,
      },
    });
    await page.waitForTimeout(250);
    const offscreen = (await cdp.send("Browser.getWindowBounds", { windowId: targetWindow.windowId })) as { bounds?: Record<string, unknown> };
    if (hiddenBounds(offscreen.bounds)) {
      return { hidden: true, method: "offscreen", bounds: offscreen.bounds, previousBounds: before.bounds };
    }

    await cdp.send("Browser.setWindowBounds", {
      windowId: targetWindow.windowId,
      bounds: { windowState: "minimized" },
    });
    await page.waitForTimeout(250);
    const minimized = (await cdp.send("Browser.getWindowBounds", { windowId: targetWindow.windowId })) as { bounds?: Record<string, unknown> };
    return {
      hidden: hiddenBounds(minimized.bounds),
      method: hiddenBounds(minimized.bounds) ? "minimized" : undefined,
      bounds: minimized.bounds,
      previousBounds: before.bounds,
      error: hiddenBounds(minimized.bounds) ? undefined : "CDP accepted hide commands but the browser window remained visible.",
    };
  } catch (error) {
    return {
      hidden: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function showBrowserWindow(page: Page, previousBounds?: Record<string, unknown>): Promise<BrowserShowResult> {
  try {
    const cdp = await page.context().newCDPSession(page);
    const targetWindow = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
    const visibleBounds = visibleWindowBounds(previousBounds);
    await cdp.send("Browser.setWindowBounds", {
      windowId: targetWindow.windowId,
      bounds: { windowState: "normal" },
    });
    await cdp.send("Browser.setWindowBounds", {
      windowId: targetWindow.windowId,
      bounds: visibleBounds,
    });
    await page.bringToFront();
    await page.waitForTimeout(250);
    const after = (await cdp.send("Browser.getWindowBounds", { windowId: targetWindow.windowId })) as { bounds?: Record<string, unknown> };
    return {
      visible: !hiddenBounds(after.bounds),
      method: "window-bounds",
      bounds: after.bounds,
      error: hiddenBounds(after.bounds) ? "CDP accepted show commands but the browser window remained hidden." : undefined,
    };
  } catch (error) {
    try {
      await page.bringToFront();
      return { visible: true, method: "bring-to-front" };
    } catch {
      return {
        visible: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

async function pageState(page: Page): Promise<PageState> {
  return (await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    challenge: Boolean(document.querySelector('iframe[src*="challenges.cloudflare.com"], #challenge-form, #challenge-stage')),
  }))) as PageState;
}

export function looksBlocked(state: Pick<PageState, "title" | "url" | "challenge">): boolean {
  return Boolean(state.challenge) || /^(?:just a moment\.*|attention required! \| cloudflare)$/i.test(state.title.trim()) || /\/cdn-cgi\/challenge/i.test(state.url);
}

async function isSignedIn(page: Page): Promise<boolean> {
  try {
    return (await page.evaluate(async () => {
      const response = await fetch("/api/auth/session", { credentials: "include", signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return false;
      const session = await response.json().catch(() => null);
      return Boolean(session && session.user);
    })) as boolean;
  } catch {
    return false;
  }
}

async function markBestComposer(page: Page): Promise<string | null> {
  return (await page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width >= 250 && r.height >= 24 && s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
    };
    const score = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.top * 20 + r.width * r.height + (el.tagName === "TEXTAREA" ? 10000 : 0);
    };
    const candidates = Array.from(document.querySelectorAll('textarea,[contenteditable="true"],[role="textbox"]'))
      .filter(visible)
      .filter((el) => !String((el.getAttribute("aria-label") || "") + " " + (el.getAttribute("placeholder") || "")).toLowerCase().includes("search"))
      .sort((a, b) => score(b) - score(a));
    const chosen = candidates[0];
    if (!chosen) return null;
    const existing = chosen.getAttribute("data-chatgpt-image-composer");
    const token = existing || "chatgpt-image-composer-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    chosen.setAttribute("data-chatgpt-image-composer", token);
    return '[data-chatgpt-image-composer="' + token + '"]';
  })) as string | null;
}

export function isChatGptChatPageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (!isChatGptUrl(value)) {
      return false;
    }
    const pathname = url.pathname.toLowerCase();
    return !["/auth", "/login", "/signup", "/signin", "/sign-in", "/api/auth"].some((prefix) => pathname.startsWith(prefix));
  } catch {
    return false;
  }
}

export async function chatPageReadiness(page: Page): Promise<ChatPageReadiness> {
  const state = await pageState(page);
  if (!isChatGptChatPageUrl(state.url)) {
    return { ready: false, hideReady: false, state, reason: "not-chatgpt-chat-url" };
  }
  if (looksBlocked(state)) {
    return { ready: false, hideReady: false, state, reason: "verification-or-security-check" };
  }
  if (!(await isSignedIn(page))) {
    return { ready: false, hideReady: false, state, reason: "not-signed-in" };
  }
  const composerSelector = await markBestComposer(page);
  if (composerSelector) {
    return { ready: true, hideReady: true, composerSelector, state, hideReason: "composer-visible" };
  }
  return { ready: false, hideReady: true, state, reason: "composer-not-visible", hideReason: "signed-in" };
}

export function generationFailureReason(text: string): string | null {
  const patterns = [
    /may violate our (?:guardrails|content policies|policies)/i,
    /similarity to third-party content/i,
    /we(?: are|['’]re) unable to generate/i,
    /(?:couldn['’]t|could not|can(?:not|['’]t)) (?:generate|create)/i,
    /unable to create/i,
    /this request (?:may )?violate/i,
    /content polic(?:y|ies)/i,
    /(?:hit|reached) (?:the|your) .{0,40}limit/i,
    /try again (?:later|in|after|tomorrow)/i,
  ];
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return pattern.source;
    }
  }
  return null;
}

async function waitForComposer(page: Page, deadline: number, signal?: AbortSignal, onBlocked?: () => Promise<void>): Promise<string> {
  let lastReadiness: ChatPageReadiness | undefined;
  do {
    throwIfAborted(signal);
    try {
      lastReadiness = await chatPageReadiness(page);
      if (lastReadiness.ready && lastReadiness.composerSelector) {
        return lastReadiness.composerSelector;
      }
      if (lastReadiness.state && looksBlocked(lastReadiness.state)) {
        await onBlocked?.();
      }
    } catch {
      lastReadiness = undefined;
    }
    await page.waitForTimeout(1000);
  } while (Date.now() < deadline);

  if (lastReadiness?.state && looksBlocked(lastReadiness.state)) {
    throw new LoginRequiredError("Timed out waiting for ChatGPT verification. Complete the check in the ChatGPT browser window (browser_visibility show displays it), then call again.");
  }
  const detail = lastReadiness?.reason ? ` Last observed state: ${lastReadiness.reason}.` : "";
  throw new LoginRequiredError(`Timed out waiting for the ChatGPT composer.${detail}`);
}

export function isConversationUrl(value: string): boolean {
  try {
    return isChatGptUrl(value) && /\/c\/[^/]+/.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

async function gotoWithinDeadline(page: Page, url: string, deadline: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const timeout = Math.max(1000, Math.min(90_000, deadline - Date.now()));
  await raceDeadline(page.goto(url, { waitUntil: "domcontentloaded", timeout }), deadline + 1000, signal, () => new Error(`Timed out loading ${url}.`));
}

async function waitForStableThread(page: Page, deadline: number, signal?: AbortSignal): Promise<boolean> {
  const until = Math.min(deadline, Date.now() + 15_000);
  let last = "";
  let stableSince = Date.now();
  while (Date.now() < until) {
    throwIfAborted(signal);
    const snapshot = await turnSnapshot(page);
    const images = (await collectImages(page)).map((image) => image.src).join("|");
    const key = `${snapshot.responseCount}:${snapshot.userCount}:${images}`;
    if (key !== last) {
      last = key;
      stableSince = Date.now();
    } else if (snapshot.responseCount + snapshot.userCount > 0 && Date.now() - stableSince >= 2000) {
      return true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function waitWhileStreaming(page: Page, deadline: number, signal?: AbortSignal): Promise<boolean> {
  while (isStreaming(await turnSnapshot(page))) {
    throwIfAborted(signal);
    if (Date.now() >= deadline) {
      return false;
    }
    await page.waitForTimeout(1000);
  }
  return true;
}

function withConversation(message: string, page: Page): string {
  const url = safePageUrl(page);
  return isConversationUrl(url) ? `${message} Conversation: ${url}` : message;
}

interface TurnSnapshot {
  turnState: string | null;
  legacyStreaming: boolean;
  responseCount: number;
  userCount: number;
  lastResponseText: string;
  lastResponseHasImage: boolean;
}

async function turnSnapshot(page: Page): Promise<TurnSnapshot> {
  return (await page.evaluate(() => {
    const states = Array.from(document.querySelectorAll("[data-talvt-turn-state]"));
    let responses = Array.from(document.querySelectorAll("[data-response-body]"));
    if (responses.length === 0) {
      responses = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
    }
    const last = responses[responses.length - 1] as HTMLElement | undefined;
    return {
      turnState: states.length ? states[states.length - 1].getAttribute("data-talvt-turn-state") : null,
      legacyStreaming: Boolean(document.querySelector('[data-testid="stop-button"]')),
      responseCount: responses.length,
      userCount: document.querySelectorAll('[data-user-message-bubble], [data-message-author-role="user"]').length,
      lastResponseText: (last?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 600),
      lastResponseHasImage: Boolean(last?.querySelector('[data-testid="generated-image-gallery"] img, img[alt^="Generated image"]')),
    };
  })) as TurnSnapshot;
}

function isStreaming(snapshot: TurnSnapshot): boolean {
  return snapshot.turnState === "in_progress" || snapshot.legacyStreaming;
}

async function collectImages(page: Page): Promise<BrowserImage[]> {
  return (await page.evaluate(() => {
    const toImage = (img: Element) => {
      const image = img as HTMLImageElement;
      const r = img.getBoundingClientRect();
      return {
        src: image.currentSrc || image.src,
        alt: image.alt || "",
        naturalWidth: image.naturalWidth || 0,
        naturalHeight: image.naturalHeight || 0,
        displayWidth: Math.round(r.width),
        displayHeight: Math.round(r.height),
      };
    };
    const generated = Array.from(document.querySelectorAll('[data-testid="generated-image-gallery"] img, main img[alt^="Generated image"]'));
    const pool = generated.length
      ? generated
      : Array.from(document.querySelectorAll("main img")).filter((img) => {
          const r = img.getBoundingClientRect();
          const image = img as HTMLImageElement;
          return (
            r.width >= 160 &&
            r.height >= 160 &&
            !image.src.startsWith("data:") &&
            !/user attachment|avatar|profile|icon|logo/i.test(image.alt || "") &&
            !img.closest('[data-user-message-bubble], [data-message-author-role="user"], [data-composer-attachments]')
          );
        });
    const seen = new Set<string>();
    return pool
      .map(toImage)
      .filter((img) => img.src && img.naturalWidth >= 256 && img.naturalHeight >= 256)
      .filter((img) => (seen.has(img.src) ? false : (seen.add(img.src), true)));
  })) as BrowserImage[];
}

async function readComposerText(page: Page, selector: string): Promise<string> {
  try {
    return (await page
      .locator(selector)
      .first()
      .evaluate((el) => (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el.textContent || ""), undefined, { timeout: 5000 })) as string;
  } catch {
    return "";
  }
}

async function clickSendNear(page: Page, composerSelector: string): Promise<void> {
  const selector = (await page.evaluate(
    (sourceSelector) => {
      const source = document.querySelector(sourceSelector);
      if (!source) return null;
      const visible = (el: HTMLButtonElement) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width >= 20 && r.height >= 20 && s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
      };
      const sr = source.getBoundingClientRect();
      const sx = sr.left + sr.width / 2;
      const sy = sr.top + sr.height / 2;
      const candidates = Array.from(document.querySelectorAll("button"))
        .filter((button) => visible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true")
        .filter((button) => {
          const label = String((button.getAttribute("aria-label") || "") + " " + (button.getAttribute("data-testid") || "")).toLowerCase();
          return /send|submit/.test(label);
        })
        .map((button) => {
          const r = button.getBoundingClientRect();
          return {
            button,
            dist: Math.hypot(r.left + r.width / 2 - sx, r.top + r.height / 2 - sy),
          };
        })
        .sort((a, b) => a.dist - b.dist);
      const chosen = candidates[0]?.button;
      if (!chosen) return null;
      const token = "chatgpt-image-send-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      chosen.setAttribute("data-chatgpt-image-send", token);
      return '[data-chatgpt-image-send="' + token + '"]';
    },
    composerSelector,
  )) as string | null;
  if (selector) {
    await page.locator(selector).first().click({ force: true });
  }
}

async function attachReferenceImages(page: Page, paths: string[], deadline: number, signal?: AbortSignal): Promise<void> {
  const input = page.locator('input[type="file"]').first();
  if ((await input.count()) === 0) {
    throw new Error("The ChatGPT page has no file upload input, so reference images cannot be attached.");
  }
  const before = await page.locator("[data-composer-attachments] img").count();
  await input.setInputFiles(paths);
  const attachDeadline = Math.min(deadline, Date.now() + 60_000);
  while (Date.now() < attachDeadline) {
    throwIfAborted(signal);
    if ((await page.locator("[data-composer-attachments] img").count()) >= before + paths.length) {
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Timed out waiting for ${paths.length} reference image(s) to attach in ChatGPT.`);
}

async function exportImageFromSrc(page: Page, image: BrowserImage, outputDir: string, index: number): Promise<GeneratedImage> {
  const payload = (await page.evaluate(
    async (src) => {
      const response = await fetch(src, { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error("fetch failed " + response.status);
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("failed to read image blob"));
        reader.readAsDataURL(blob);
      });
      return { dataUrl, mimeType: blob.type || "image/png" };
    },
    image.src,
  )) as { dataUrl: string; mimeType?: string };

  const match = /^data:([^;]+);base64,(.+)$/s.exec(payload.dataUrl);
  if (!match) {
    throw new Error("Image fetch did not return a data URL.");
  }
  const mimeType = payload.mimeType || match[1] || "image/png";
  return {
    path: await writeBase64Image({
      base64: match[2],
      outputDir,
      index,
      mimeType,
    }),
    mimeType,
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Image generation was cancelled.");
  }
}

async function raceDeadline<T>(work: Promise<T>, deadline: number, signal: AbortSignal | undefined, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), Math.max(0, deadline - Date.now()));
        onAbort = () => reject(new Error("Image generation was cancelled."));
        if (signal?.aborted) onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export interface SendPromptParams {
  prompt: string;
  deadline: number;
  maxImages: number;
  conversationMode: "new" | "continue";
  conversationUrl?: string;
  referenceImages?: string[];
  signal?: AbortSignal;
  onBlocked?: () => Promise<void>;
  completedTurnGraceMs?: number;
}

export async function sendPromptAndExport(page: Page, config: AppConfig, params: SendPromptParams): Promise<GenerateImageResult> {
  const prompt = params.prompt.trim();
  if (!prompt) {
    throw new Error("Prompt cannot be empty.");
  }
  const { deadline, signal } = params;
  const graceMs = params.completedTurnGraceMs ?? 8000;
  const warnings: string[] = [];

  if (params.conversationUrl) {
    if (!isConversationUrl(params.conversationUrl)) {
      throw new Error(`conversation_url must be a chatgpt.com conversation URL: ${params.conversationUrl}`);
    }
    if (safePageUrl(page) !== params.conversationUrl) {
      await gotoWithinDeadline(page, params.conversationUrl, deadline, signal);
    }
  } else if (params.conversationMode === "new") {
    await gotoWithinDeadline(page, CHATGPT_URL, deadline, signal);
  }
  await page.keyboard.press("Escape").catch(() => undefined);
  let composerSelector = await waitForComposer(page, deadline, signal, params.onBlocked);
  const continuing = Boolean(params.conversationUrl) || params.conversationMode === "continue";
  if (continuing) {
    if (isConversationUrl(safePageUrl(page))) {
      if (!(await waitForStableThread(page, deadline, signal))) {
        warnings.push("The ChatGPT conversation history did not finish loading before the prompt was sent.");
      }
      if (!(await waitWhileStreaming(page, deadline, signal))) {
        throw new Error(withConversation("The previous ChatGPT reply in this conversation was still generating at the deadline, so the prompt was not sent. Use collect_images to save it.", page));
      }
    } else {
      warnings.push("No ChatGPT conversation was open to continue, so the prompt started a new chat.");
    }
  }

  if (params.referenceImages?.length) {
    await attachReferenceImages(page, params.referenceImages, deadline, signal);
    composerSelector = await waitForComposer(page, deadline, signal, params.onBlocked);
  }
  const knownSources = new Set((await collectImages(page)).map((image) => image.src));
  const baseline = await turnSnapshot(page);
  throwIfAborted(signal);
  if (Date.now() >= deadline) {
    throw new Error(withConversation("The time limit ran out before the prompt could be sent, so it was not sent.", page));
  }

  const composer = page.locator(composerSelector).first();
  await composer.click({ force: true });
  try {
    await composer.fill(prompt);
  } catch {
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.insertText(prompt);
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  if ((await readComposerText(page, composerSelector)).trim()) {
    await clickSendNear(page, composerSelector);
  }

  let exported: GeneratedImage[] = [];
  let outputDir = "";
  let completedWithoutImageSince: number | undefined;
  while (true) {
    throwIfAborted(signal);
    const state = await pageState(page);
    if (looksBlocked(state)) {
      await params.onBlocked?.();
      if (Date.now() >= deadline) {
        throw new LoginRequiredError(withConversation("ChatGPT is showing a verification check. Complete it in the ChatGPT browser window (browser_visibility show displays it), then call again.", page));
      }
      await page.waitForTimeout(2500);
      continue;
    }

    const snapshot = await turnSnapshot(page);
    const fresh = (await collectImages(page)).filter((image) => !knownSources.has(image.src));
    const streaming = isStreaming(snapshot);
    const expired = Date.now() >= deadline;

    if (fresh.length > 0 && (!streaming || expired)) {
      if (streaming) {
        warnings.push("The ChatGPT turn had not finished at the deadline, so the saved image may be a preview.");
      } else {
        await page.waitForTimeout(1500);
      }
      const finalFresh = (await collectImages(page)).filter((image) => !knownSources.has(image.src));
      const selected = (finalFresh.length > 0 ? finalFresh : fresh).slice(-params.maxImages);
      outputDir = await createOutputDir(config.outputRoot, prompt);
      exported = await exportImages(page, selected, outputDir);
      break;
    }

    const newResponse = snapshot.responseCount > baseline.responseCount;
    if (fresh.length === 0 && newResponse && snapshot.turnState === "complete") {
      completedWithoutImageSince ??= Date.now();
      if (Date.now() - completedWithoutImageSince >= graceMs) {
        const reply = snapshot.lastResponseText || "(empty reply)";
        if (generationFailureReason(reply)) {
          throw new ImageGenerationRefusedError(withConversation(`ChatGPT did not create an image: ${reply}`, page));
        }
        throw new Error(withConversation(`ChatGPT replied without an image: ${reply}`, page));
      }
    } else {
      completedWithoutImageSince = undefined;
    }

    if (expired) {
      const diagnosticDir = await createOutputDir(config.outputRoot, prompt);
      const diagnostic = path.join(diagnosticDir, "diagnostic-timeout.png");
      await page.screenshot({ path: diagnostic }).catch(() => undefined);
      throw new Error(withConversation(`Timed out waiting for an image; collect_images can fetch it later if ChatGPT finishes. Diagnostic screenshot: ${diagnostic}.`, page));
    }
    await page.waitForTimeout(1000);
  }

  return saveWebResult(outputDir, exported, page, {
    prompt,
    conversationMode: continuing ? "continue" : "new",
    referenceImages: params.referenceImages ?? [],
    warnings,
  });
}

async function exportImages(page: Page, images: BrowserImage[], outputDir: string): Promise<GeneratedImage[]> {
  const results = await Promise.allSettled(images.map((image, index) => exportImageFromSrc(page, image, outputDir, index + 1)));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) {
    await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    throw failure.reason;
  }
  return results.map((result) => (result as PromiseFulfilledResult<GeneratedImage>).value);
}

async function saveWebResult(
  outputDir: string,
  images: GeneratedImage[],
  page: Page,
  info: { prompt: string; conversationMode: string; referenceImages: string[]; warnings: string[] },
): Promise<GenerateImageResult> {
  const conversationUrl = safePageUrl(page);
  await writeMetadata(outputDir, {
    backend: "chatgpt-web",
    mode: "direct-typescript-browser",
    prompt: info.prompt,
    created_at: new Date().toISOString(),
    images,
    conversation_mode: info.conversationMode,
    conversation_url: conversationUrl,
    reference_images: info.referenceImages,
    warnings: info.warnings,
  });
  return {
    status: "saved",
    backend: "chatgpt-web",
    prompt: info.prompt,
    outputDir,
    images,
    primaryImage: images[0],
    warnings: info.warnings,
    metadata: {
      mode: "direct-typescript-browser",
      conversation_mode: info.conversationMode,
      conversation_url: conversationUrl,
    },
  };
}

export async function collectConversationImages(
  page: Page,
  config: AppConfig,
  params: { conversationUrl: string; deadline: number; maxImages: number; signal?: AbortSignal; onBlocked?: () => Promise<void> },
): Promise<GenerateImageResult> {
  const { deadline, signal } = params;
  if (!isConversationUrl(params.conversationUrl)) {
    throw new Error(`conversation_url must be a chatgpt.com conversation URL: ${params.conversationUrl}`);
  }
  if (safePageUrl(page) !== params.conversationUrl) {
    await gotoWithinDeadline(page, params.conversationUrl, deadline, signal);
  }
  await waitForComposer(page, deadline, signal, params.onBlocked);
  const warnings: string[] = [];
  if (!(await waitForStableThread(page, deadline, signal))) {
    warnings.push("The ChatGPT conversation history did not finish loading.");
  }
  if (!(await waitWhileStreaming(page, deadline, signal))) {
    throw new Error(withConversation("ChatGPT is still generating the latest reply; call collect_images again later.", page));
  }
  const latest = await turnSnapshot(page);
  const images = (await collectImages(page)).slice(-params.maxImages);
  if (images.length === 0) {
    throw new Error(withConversation(["The ChatGPT conversation has no generated images.", ...warnings].join(" "), page));
  }
  if (!latest.lastResponseHasImage) {
    warnings.push(`The latest ChatGPT reply has no image (${latest.lastResponseText || "empty reply"}); saved the most recent earlier image instead.`);
  }
  const prompt = `collected from ${params.conversationUrl}`;
  const outputDir = await createOutputDir(config.outputRoot, "collected");
  const exported = await exportImages(page, images, outputDir);
  return saveWebResult(outputDir, exported, page, { prompt, conversationMode: "collect", referenceImages: [], warnings });
}
