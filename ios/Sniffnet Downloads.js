// Sniffnet Downloads for Scriptable
//
// Run this script once inside Scriptable to store your TRMNL device API key.
// Then add a medium Scriptable widget and select this script.

// The key is stored in Scriptable's encrypted Keychain, not in this script.


const CURRENT_SCREEN_URL = "https://trmnl.com/api/display/current";
const TRMNL_DASHBOARD_URL = "https://trmnl.com";
const KEYCHAIN_KEY = "sniffnet-downloads.trmnl-device-api-key";
const CACHE_IMAGE_NAME = "sniffnet-downloads-current-screen.png";
const CACHE_METADATA_NAME = "sniffnet-downloads-current-screen.json";
const MINIMUM_REFRESH_MINUTES = 15;
const DEFAULT_REFRESH_MINUTES = 60;
const MAXIMUM_CACHE_AGE_HOURS = 24;

const files = FileManager.local();
const cacheDirectory = files.joinPath(files.cacheDirectory(), "sniffnet-downloads");
const cachedImagePath = files.joinPath(cacheDirectory, CACHE_IMAGE_NAME);
const cachedMetadataPath = files.joinPath(cacheDirectory, CACHE_METADATA_NAME);

function ensureCacheDirectory() {
  if (!files.fileExists(cacheDirectory)) files.createDirectory(cacheDirectory, true);
}

function readCachedScreen() {
  if (!files.fileExists(cachedImagePath)) return null;

  let metadata = {};
  if (files.fileExists(cachedMetadataPath)) {
    try {
      metadata = JSON.parse(files.readString(cachedMetadataPath));
    } catch (_error) {
      metadata = {};
    }
  }

  return {
    image: files.readImage(cachedImagePath),
    refreshSeconds: Number(metadata.refreshSeconds),
    cachedAt: Date.parse(metadata.cachedAt),
  };
}

function cacheScreen(image, refreshSeconds) {
  ensureCacheDirectory();
  files.writeImage(cachedImagePath, image);
  files.writeString(cachedMetadataPath, JSON.stringify({
    refreshSeconds,
    cachedAt: new Date().toISOString(),
  }));
}

async function requestDeviceKey() {
  const alert = new Alert();
  alert.title = "Connect Sniffnet Downloads";
  alert.message = [
    "Paste the Device API key from TRMNL → Devices → Edit → Developer perks.",
    "The key stays in the Scriptable Keychain on this iPhone.",
  ].join("\n\n");
  alert.addSecureTextField("TRMNL Device API key", "");
  alert.addAction("Save");
  alert.addCancelAction("Cancel");

  const choice = await alert.presentAlert();
  if (choice === -1) return null;

  const key = alert.textFieldValue(0).trim();
  if (!key) throw new Error("The Device API key cannot be empty.");
  return key;
}

async function configurationAction() {
  if (!Keychain.contains(KEYCHAIN_KEY)) return "connect";

  const alert = new Alert();
  alert.title = "Sniffnet Downloads";
  alert.message = "Preview the widget or replace the saved TRMNL Device API key.";
  alert.addAction("Preview widget");
  alert.addAction("Replace API key");
  alert.addDestructiveAction("Remove API key");
  alert.addCancelAction("Cancel");

  const choice = await alert.presentAlert();
  if (choice === 0) return "preview";
  if (choice === 1) return "connect";
  if (choice === 2) return "remove";
  return "cancel";
}

async function fetchCurrentScreen(deviceKey) {
  const screenRequest = new Request(CURRENT_SCREEN_URL);
  screenRequest.headers = {
    Accept: "application/json",
    "access-token": deviceKey,
  };
  screenRequest.timeoutInterval = 15;

  const screen = await screenRequest.loadJSON();
  if (Number(screen.status) !== 200 || !screen.image_url) {
    const detail = screen.error || screen.message || `TRMNL returned status ${screen.status}`;
    throw new Error(detail);
  }

  const imageRequest = new Request(screen.image_url);
  imageRequest.timeoutInterval = 15;
  const image = await imageRequest.loadImage();
  const refreshSeconds = Number(screen.refresh_rate);
  cacheScreen(image, refreshSeconds);

  return { image, refreshSeconds };
}

function refreshDate(refreshSeconds) {
  const requestedMinutes = Number.isFinite(refreshSeconds) && refreshSeconds > 0
    ? Math.ceil(refreshSeconds / 60)
    : DEFAULT_REFRESH_MINUTES;
  const minutes = Math.max(MINIMUM_REFRESH_MINUTES, requestedMinutes);
  return new Date(Date.now() + minutes * 60 * 1000);
}

function screenWidget(screen) {
  const widget = new ListWidget();
  widget.backgroundColor = Color.white();
  widget.setPadding(0, 0, 0, 0);
  widget.url = TRMNL_DASHBOARD_URL;
  widget.refreshAfterDate = refreshDate(screen.refreshSeconds);

  widget.addSpacer();
  const image = widget.addImage(screen.image);
  image.applyFittingContentMode();
  image.centerAlignImage();
  image.containerRelativeShape = true;
  widget.addSpacer();

  return widget;
}

function messageWidget(title, detail) {
  const widget = new ListWidget();
  widget.backgroundColor = Color.white();
  widget.setPadding(16, 16, 16, 16);
  widget.url = URLScheme.forRunningScript();
  widget.refreshAfterDate = refreshDate(DEFAULT_REFRESH_MINUTES * 60);

  const heading = widget.addText(title);
  heading.font = Font.boldSystemFont(15);
  heading.textColor = Color.black();
  heading.lineLimit = 2;

  widget.addSpacer(7);
  const message = widget.addText(detail);
  message.font = Font.systemFont(11);
  message.textColor = new Color("555555");
  message.lineLimit = 4;

  widget.addSpacer();
  const footer = widget.addText("Tap to configure");
  footer.font = Font.semiboldSystemFont(10);
  footer.textColor = new Color("777777");

  return widget;
}

async function buildWidget(deviceKey) {
  try {
    return screenWidget(await fetchCurrentScreen(deviceKey));
  } catch (error) {
    const cached = readCachedScreen();
    const maximumCacheAge = MAXIMUM_CACHE_AGE_HOURS * 60 * 60 * 1000;
    if (cached && Number.isFinite(cached.cachedAt) && Date.now() - cached.cachedAt <= maximumCacheAge) {
      return screenWidget(cached);
    }
    return messageWidget("Sniffnet Downloads", error.message || String(error));
  }
}

let action = config.runsInApp ? await configurationAction() : "widget";

if (action === "remove") {
  Keychain.remove(KEYCHAIN_KEY);
  const confirmation = new Alert();
  confirmation.title = "API key removed";
  confirmation.message = "Run the script again whenever you want to reconnect.";
  confirmation.addAction("Done");
  await confirmation.presentAlert();
  Script.complete();
} else if (action === "cancel") {
  Script.complete();
} else {
  let deviceKey = Keychain.contains(KEYCHAIN_KEY) ? Keychain.get(KEYCHAIN_KEY) : null;
  let connectedScreen = null;

  if (action === "connect") {
    try {
      const candidateKey = await requestDeviceKey();
      if (candidateKey) {
        connectedScreen = await fetchCurrentScreen(candidateKey);
        Keychain.set(KEYCHAIN_KEY, candidateKey);
        deviceKey = candidateKey;
      }
    } catch (error) {
      const alert = new Alert();
      alert.title = "Could not connect to TRMNL";
      alert.message = error.message || String(error);
      alert.addAction("OK");
      await alert.presentAlert();
    }
  }

  let widget;
  if (connectedScreen) {
    widget = screenWidget(connectedScreen);
  } else if (!deviceKey) {
    widget = messageWidget(
      "Setup required",
      "Open this script in Scriptable and add your TRMNL Device API key.",
    );
  } else {
    widget = await buildWidget(deviceKey);
  }

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else if (deviceKey) {
    await widget.presentMedium();
  }

  Script.complete();
}
