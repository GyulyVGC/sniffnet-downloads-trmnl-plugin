const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const scriptPath = path.join(__dirname, "..", "ios", "Sniffnet Downloads.js");
const scriptSource = fs.readFileSync(scriptPath, "utf8");
const CURRENT_SCREEN_URL = "https://trmnl.com/api/display/current";
const CACHE_DIRECTORY = "/cache/sniffnet-downloads";
const CACHE_IMAGE_PATH = `${CACHE_DIRECTORY}/sniffnet-downloads-current-screen.png`;
const CACHE_METADATA_PATH = `${CACHE_DIRECTORY}/sniffnet-downloads-current-screen.json`;
const KEYCHAIN_KEY = "sniffnet-downloads.trmnl-device-api-key";

function runtime(options = {}) {
  const requests = [];
  const widgets = [];
  const keychain = new Map();
  const storedFiles = new Map(Object.entries(options.files || {}));
  const alertChoices = [...(options.alertChoices || [])];
  const alertText = [...(options.alertText || [])];
  const state = { completed: false, configuredWidget: null };

  if (options.deviceKey) keychain.set(KEYCHAIN_KEY, options.deviceKey);

  class FileManagerMock {
    static local() { return new FileManagerMock(); }
    cacheDirectory() { return "/cache"; }
    joinPath(left, right) { return `${left}/${right}`; }
    fileExists(filePath) { return storedFiles.has(filePath); }
    createDirectory() {}
    readString(filePath) { return storedFiles.get(filePath); }
    readImage(filePath) { return storedFiles.get(filePath); }
    writeString(filePath, value) { storedFiles.set(filePath, value); }
    writeImage(filePath, value) { storedFiles.set(filePath, value); }
  }

  class RequestMock {
    constructor(url) {
      this.url = url;
      this.headers = {};
      requests.push(this);
    }

    async loadJSON() {
      if (options.screenError) throw options.screenError;
      return options.screen || {
        status: 200,
        image_url: "https://images.example.test/sniffnet.png",
        refresh_rate: 3600,
      };
    }

    async loadImage() {
      if (options.imageError) throw options.imageError;
      return options.image || { kind: "fresh-image" };
    }
  }

  class AlertMock {
    addSecureTextField() {}
    addAction() {}
    addCancelAction() {}
    addDestructiveAction() {}
    async presentAlert() { return alertChoices.shift() ?? 0; }
    textFieldValue() { return alertText.shift() ?? ""; }
  }

  class ListWidgetMock {
    constructor() {
      this.images = [];
      this.texts = [];
      widgets.push(this);
    }

    setPadding(...padding) { this.padding = padding; }
    addSpacer() {}
    addImage(image) {
      const item = {
        image,
        applyFittingContentMode() { this.fitting = true; },
        centerAlignImage() { this.centered = true; },
      };
      this.images.push(item);
      return item;
    }
    addText(text) {
      const item = { text };
      this.texts.push(item);
      return item;
    }
    async presentMedium() { this.presented = true; }
  }

  class ColorMock {
    constructor(value) { this.value = value; }
    static white() { return new ColorMock("white"); }
    static black() { return new ColorMock("black"); }
  }

  const dependencies = {
    config: { runsInApp: options.runsInApp === true, runsInWidget: options.runsInApp !== true },
    FileManager: FileManagerMock,
    Keychain: {
      contains: (key) => keychain.has(key),
      get: (key) => keychain.get(key),
      set: (key, value) => keychain.set(key, value),
      remove: (key) => keychain.delete(key),
    },
    Alert: AlertMock,
    Request: RequestMock,
    ListWidget: ListWidgetMock,
    Color: ColorMock,
    Font: {
      boldSystemFont: (size) => ({ kind: "bold", size }),
      systemFont: (size) => ({ kind: "regular", size }),
      semiboldSystemFont: (size) => ({ kind: "semibold", size }),
    },
    URLScheme: { forRunningScript: () => "scriptable:///run/current" },
    Script: {
      setWidget: (widget) => { state.configuredWidget = widget; },
      complete: () => { state.completed = true; },
    },
  };

  async function run() {
    const names = Object.keys(dependencies);
    const execute = new AsyncFunction(...names, scriptSource);
    await execute(...names.map((name) => dependencies[name]));
    return { requests, widgets, keychain, storedFiles, state };
  }

  return { run };
}

test("iOS widget only fetches TRMNL's rendered current-screen image", async () => {
  assert.doesNotMatch(scriptSource, /api\.github\.com|crates\.io|homebrew-core/);

  const freshImage = { kind: "fresh-image" };
  const result = await runtime({ deviceKey: "device-secret", image: freshImage }).run();

  assert.equal(result.requests.length, 2);
  assert.equal(result.requests[0].url, CURRENT_SCREEN_URL);
  assert.deepEqual(result.requests[0].headers, {
    Accept: "application/json",
    "access-token": "device-secret",
  });
  assert.equal(result.requests[1].url, "https://images.example.test/sniffnet.png");
  assert.equal(result.state.configuredWidget.images[0].image, freshImage);
  assert.equal(result.storedFiles.get(CACHE_IMAGE_PATH), freshImage);
  assert.equal(result.state.completed, true);
});

test("iOS widget uses a recent cached image when TRMNL is temporarily unavailable", async () => {
  const cachedImage = { kind: "cached-image" };
  const result = await runtime({
    deviceKey: "device-secret",
    screenError: new Error("network unavailable"),
    files: {
      [CACHE_IMAGE_PATH]: cachedImage,
      [CACHE_METADATA_PATH]: JSON.stringify({
        refreshSeconds: 3600,
        cachedAt: new Date().toISOString(),
      }),
    },
  }).run();

  assert.equal(result.requests.length, 1);
  assert.equal(result.state.configuredWidget.images[0].image, cachedImage);
});

test("iOS widget surfaces an error instead of displaying a cache older than 24 hours", async () => {
  const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  const result = await runtime({
    deviceKey: "device-secret",
    screenError: new Error("network unavailable"),
    files: {
      [CACHE_IMAGE_PATH]: { kind: "stale-image" },
      [CACHE_METADATA_PATH]: JSON.stringify({ refreshSeconds: 3600, cachedAt: staleDate }),
    },
  }).run();

  assert.equal(result.state.configuredWidget.images.length, 0);
  assert.deepEqual(
    result.state.configuredWidget.texts.map((item) => item.text),
    ["Sniffnet Downloads", "network unavailable", "Tap to configure"],
  );
});

test("setup validates a Device API key before saving it", async () => {
  const valid = await runtime({
    runsInApp: true,
    alertChoices: [0],
    alertText: ["new-device-key"],
  }).run();

  assert.equal(valid.keychain.get(KEYCHAIN_KEY), "new-device-key");
  assert.equal(valid.requests[0].headers["access-token"], "new-device-key");
  assert.equal(valid.widgets.at(-1).presented, true);

  const invalid = await runtime({
    runsInApp: true,
    alertChoices: [0, 0],
    alertText: ["invalid-device-key"],
    screenError: new Error("Device not found"),
  }).run();

  assert.equal(invalid.keychain.has(KEYCHAIN_KEY), false);
});
