/*
 * Copyright 2024-2026 Breaking IT
 *
 * Licensed under the BreakTest Community Source License 1.0.
 * You may not use this file except in compliance with that license.
 * See the LICENSE file at the root of this distribution.
 */

const INCOGNITO_LAUNCH_KEY = "pendingIncognitoLaunch";
const INCOGNITO_LAUNCH_TTL_MS = 60_000;

const openButton = document.querySelector("#open-recorder-button");
const statusText = document.querySelector("#launcher-status");
const details = document.querySelector("#launch-details");
const transactionText = document.querySelector("#launch-transaction");
const urlText = document.querySelector("#launch-url");

let currentWindowId;
let currentTabId;
let currentLaunch;
const launchNonce = new URL(location.href).searchParams.get("launch");

openButton.addEventListener("click", async () => {
  openButton.disabled = true;
  statusText.textContent = "Opening the recorder…";
  try {
    await chrome.sidePanel.setOptions({
      tabId: currentTabId,
      path: "sidepanel.html",
      enabled: true
    });
    await chrome.sidePanel.open({tabId: currentTabId});
    statusText.textContent = "Recorder opened. Starting the recording…";
    const response = await chrome.runtime.sendMessage({
      type: "start-incognito-recording",
      nonce: currentLaunch.nonce
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Unable to start the incognito recording");
    }
  } catch (error) {
    statusText.textContent = `Unable to open the recorder: ${error.message}`;
    openButton.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[INCOGNITO_LAUNCH_KEY]) {
    showLaunch(changes[INCOGNITO_LAUNCH_KEY].newValue);
  }
});

initialize();

async function initialize() {
  try {
    if (!chrome.extension.inIncognitoContext) {
      throw new Error("This launcher only works in an incognito window");
    }
    if (!launchNonce) {
      throw new Error("The recorder launch instruction is missing");
    }
    const currentTab = await chrome.tabs.getCurrent();
    if (!Number.isInteger(currentTab?.id) || !Number.isInteger(currentTab.windowId)) {
      throw new Error("Chrome did not provide the launcher tab details");
    }
    currentWindowId = currentTab.windowId;
    currentTabId = currentTab.id;
    const stored = await chrome.storage.local.get(INCOGNITO_LAUNCH_KEY);
    const launch = stored[INCOGNITO_LAUNCH_KEY];
    if (!isValidLaunch(launch) || launch.nonce !== launchNonce) {
      throw new Error("The recorder launch instruction expired; close this window and try again");
    }
    const readyLaunch = {
      ...launch,
      windowId: currentTab.windowId,
      launcherTabId: currentTab.id
    };
    await chrome.storage.local.set({[INCOGNITO_LAUNCH_KEY]: readyLaunch});
    showLaunch(readyLaunch);
  } catch (error) {
    statusText.textContent = error.message;
  }
}

function showLaunch(launch) {
  if (!isValidLaunch(launch)
      || launch.nonce !== launchNonce
      || launch.windowId !== currentWindowId) {
    return;
  }
  currentLaunch = launch;
  transactionText.textContent = launch.transactionName;
  urlText.textContent = launch.startUrl || "Blank page";
  details.hidden = false;
  openButton.disabled = false;
  statusText.textContent = "Your isolated browser session is ready.";
}

function isValidLaunch(launch) {
  return launch
    && typeof launch.transactionName === "string"
    && typeof launch.startUrl === "string"
    && Number.isFinite(launch.createdAt)
    && Date.now() - launch.createdAt <= INCOGNITO_LAUNCH_TTL_MS;
}
