// Loaded with `node --import` before dist/index.js in offline tests: every browser the server
// launches runs headless and sees the local chatgpt.com fixture instead of the real site.
// FIXTURE_CONTROL names a JSON file ({ "signedIn": true, "historyDelayMs": 0 }) re-read on every request.
import { readFileSync } from "node:fs";

import { chromium } from "patchright";

import { installFixtureRoutes } from "./chatgpt-fixture.mjs";

const readControl = () => {
  try {
    return JSON.parse(readFileSync(process.env.FIXTURE_CONTROL, "utf8"));
  } catch {
    return {};
  }
};

const launch = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = async (userDataDir, options = {}) => {
  const context = await launch(userDataDir, { ...options, headless: true });
  await installFixtureRoutes(context, readControl);
  return context;
};
