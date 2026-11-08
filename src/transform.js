const METRIC_KEYS = ["gw", "gm", "gl", "gu", "c", "b", "d"];
const METRIC_BUCKET_INDEXES = {
  gw: [1, 5],
  gm: [1, 6],
  gl: [1, 7],
  gu: [1, 8],
  c: [2, 8],
  b: [3, 6],
  d: [4, 7],
};
const HOUR_MS = 60 * 60 * 1000;
const HISTORY_HOURS = 24;
const STATE_VERSION = 2;
const Y_AXIS_LABEL_GAP_PERCENT = 15;
const CHART_MIN_HEIGHT_PERCENT = 4;
const SHARE_MIN_WIDTH_PERCENT = 3;
const SHARE_MAX_WIDTH_PERCENT = 97;
// Leave headroom inside TRMNL's five-second Serverless execution limit.
const REQUEST_TIMEOUT_MS = 3500;

function logSourceError(source, error) {
  const detail = error && error.message ? error.message : String(error || "unknown error");
  console.error(`[Sniffnet Downloads] ${source}: ${detail}`);
}

function customField(input, key) {
  const direct = input && input[key];
  const nested = input && input.trmnl && input.trmnl.plugin_settings &&
    input.trmnl.plugin_settings.custom_fields_values &&
    input.trmnl.plugin_settings.custom_fields_values[key];
  return String(direct || nested || "").trim();
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response;
}

function packageDownloadCount(html) {
  const match = html.match(/Total downloads<\/span>[\s\S]{0,200}?title="([0-9]+)"/i);
  if (!match) throw new Error("download count was not found in package page");
  return Number(match[1]);
}

function githubPlatform(assetName) {
  const name = String(assetName || "").toLowerCase();
  if (name.includes("windows")) return "gw";
  if (name.includes("macos")) return "gm";
  if (name.includes("linux") || /\.(deb|rpm|appimage)$/.test(name)) return "gl";
  return "gu";
}

async function collect(input) {
  const githubToken = customField(input, "github_token");
  const githubHeaders = {
    Accept: "application/vnd.github+json",
    "User-Agent": "sniffnet-trmnl-download-stats",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (githubToken) githubHeaders.Authorization = `Bearer ${githubToken}`;

  const tasks = {
    github: request(
      "https://api.github.com/repos/gyulyvgc/sniffnet/releases?per_page=100",
      { headers: githubHeaders },
    ).then((response) => response.json()),
    crates: request("https://crates.io/api/v1/crates/sniffnet", {
      headers: { "User-Agent": "sniffnet-trmnl-download-stats (https://sniffnet.app)" },
    }).then((response) => response.json()),
    homebrew: request("https://github.com/Homebrew/homebrew-core/pkgs/container/core%2Fsniffnet", {
      headers: { "User-Agent": "sniffnet-trmnl-download-stats" },
    }).then((response) => response.text()),
    docker: request("https://github.com/gyulyvgc/sniffnet/pkgs/container/sniffnet", {
      headers: { "User-Agent": "sniffnet-trmnl-download-stats" },
    }).then((response) => response.text()),
  };

  const names = Object.keys(tasks);
  const settled = await Promise.allSettled(Object.values(tasks));
  const results = Object.fromEntries(names.map((name, index) => [name, settled[index]]));
  const metrics = Object.fromEntries(METRIC_KEYS.map((key) => [key, null]));
  const warnings = [];
  const failedSources = [];

  if (results.github.status === "fulfilled" && Array.isArray(results.github.value)) {
    metrics.gw = 0;
    metrics.gm = 0;
    metrics.gl = 0;
    metrics.gu = 0;
    for (const release of results.github.value) {
      for (const asset of release.assets || []) {
        const count = Number(asset.download_count);
        if (Number.isFinite(count) && count >= 0) {
          metrics[githubPlatform(asset.name)] += count;
        }
      }
    }
    if (results.github.value.length === 100) {
      warnings.push("GitHub has 100+ releases; pagination is required");
    }
  } else {
    const detail = results.github.reason && results.github.reason.message;
    logSourceError(
      "GitHub",
      results.github.status === "rejected" ? results.github.reason : "invalid response",
    );
    warnings.push(`GitHub unavailable${detail ? ` (${detail})` : ""}`);
    failedSources.push("GitHub");
  }

  if (results.crates.status === "fulfilled") {
    const count = Number(results.crates.value && results.crates.value.crate && results.crates.value.crate.downloads);
    if (Number.isFinite(count) && count >= 0) metrics.c = count;
    else {
      logSourceError("crates.io", "invalid download count");
      warnings.push("crates.io returned an invalid count");
      failedSources.push("crates.io");
    }
  } else {
    logSourceError("crates.io", results.crates.reason);
    warnings.push("crates.io unavailable");
    failedSources.push("crates.io");
  }

  for (const [source, key] of [["homebrew", "b"], ["docker", "d"]]) {
    if (results[source].status === "fulfilled") {
      try {
        metrics[key] = packageDownloadCount(results[source].value);
      } catch (error) {
        logSourceError(source === "homebrew" ? "Homebrew" : "Docker", error);
        warnings.push(`${source} returned an invalid count`);
        failedSources.push(source === "homebrew" ? "Homebrew" : "Docker");
      }
    } else {
      logSourceError(
        source === "homebrew" ? "Homebrew" : "Docker",
        results[source].reason,
      );
      warnings.push(`${source} unavailable`);
      failedSources.push(source === "homebrew" ? "Homebrew" : "Docker");
    }
  }

  return { metrics, warnings, failedSources };
}

function sum(object) {
  return Object.values(object).reduce((total, value) => total + value, 0);
}

function grouped(metrics) {
  return {
    sources: {
      github: metrics.gw + metrics.gm + metrics.gl + metrics.gu,
      crates: metrics.c,
      homebrew: metrics.b,
      docker: metrics.d,
    },
    platforms: {
      windows: metrics.gw,
      macos: metrics.gm + metrics.b,
      linux: metrics.gl + metrics.d,
      unknown: metrics.gu + metrics.c,
    },
  };
}

function packedHour(timestamp, sources, platforms, hasErrors = false) {
  return [
    timestamp,
    sources.github,
    sources.crates,
    sources.homebrew,
    sources.docker,
    platforms.windows,
    platforms.macos,
    platforms.linux,
    platforms.unknown,
    hasErrors,
  ];
}

function unpackedHour(row) {
  return {
    timestamp: row[0],
    sources: { github: row[1], crates: row[2], homebrew: row[3], docker: row[4] },
    platforms: { windows: row[5], macos: row[6], linux: row[7], unknown: row[8] },
    hasErrors: row[9] === true,
  };
}

function emptyPackedHour(timestamp) {
  return packedHour(
    timestamp,
    { github: 0, crates: 0, homebrew: 0, docker: 0 },
    { windows: 0, macos: 0, linux: 0, unknown: 0 },
  );
}

function ensurePackedHour(historyByHour, timestamp) {
  if (!historyByHour.has(timestamp)) {
    historyByHour.set(timestamp, emptyPackedHour(timestamp));
  }
  return historyByHour.get(timestamp);
}

function allocateMetricDelta(
  historyByHour,
  coveredHours,
  key,
  delta,
  start,
  end,
  retainStart,
  retainEnd,
) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  const integerDelta = Math.max(0, Math.round(delta));
  const duration = end - start;
  const firstHour = Math.max(Math.floor(start / HOUR_MS) * HOUR_MS, retainStart);
  const lastHour = Math.min(Math.floor((end - 1) / HOUR_MS) * HOUR_MS, retainEnd);

  for (let timestamp = firstHour; timestamp <= lastHour; timestamp += HOUR_MS) {
    const overlapStart = Math.max(start, timestamp);
    const overlapEnd = Math.min(end, timestamp + HOUR_MS);
    // Rounded cumulative counts telescope, so every bucket is an integer and no count is lost.
    const countBefore = Math.round(integerDelta * (overlapStart - start) / duration);
    const countAfter = Math.round(integerDelta * (overlapEnd - start) / duration);
    const row = ensurePackedHour(historyByHour, timestamp);
    coveredHours.add(timestamp);
    for (const index of METRIC_BUCKET_INDEXES[key]) row[index] += countAfter - countBefore;
  }
}

function rowData(name, value, hourlyValue, total) {
  const percent = total > 0 ? Math.round((value / total) * 100) : 0;
  return {
    name,
    value,
    formatted: value.toLocaleString("en-US"),
    hourly_formatted: hourlyValue.toLocaleString("en-US"),
    percent,
    width: value > 0
      ? (value === total
        ? 100
        : Math.min(SHARE_MAX_WIDTH_PERCENT, Math.max(SHARE_MIN_WIDTH_PERCENT, percent)))
      : 0,
  };
}

function safeState(input) {
  const candidate = input && input.trmnl && input.trmnl.state;
  return candidate && typeof candidate === "object" ? candidate : {};
}

function localTimeZone(input) {
  const user = input && input.trmnl && input.trmnl.user;
  return String(
    (user && (user.time_zone_iana || user.time_zone || user.timezone)) || "Europe/Rome",
  ).trim();
}

function formattedUpdatedAt(timestamp, timeZone) {
  const options = {
    timeZone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  };

  try {
    return new Intl.DateTimeFormat("en-GB", options).format(new Date(timestamp)).replace(",", "");
  } catch (_error) {
    options.timeZone = "Europe/Rome";
    return new Intl.DateTimeFormat("en-GB", options).format(new Date(timestamp)).replace(",", "");
  }
}

function formattedHour(timestamp, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hour12: false,
    }).format(new Date(timestamp));
  } catch (_error) {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Rome",
      hour: "2-digit",
      hour12: false,
    }).format(new Date(timestamp));
  }
}

async function run(input) {
  const storedState = safeState(input);
  const previousState = storedState.v === STATE_VERSION ? storedState : {};
  const previousMetrics = previousState.m && typeof previousState.m === "object" ? previousState.m : {};
  const previousTimes = previousState.t && typeof previousState.t === "object" ? previousState.t : {};
  const { metrics: observed, warnings, failedSources } = await collect(input || {});
  const now = Date.now();
  const current = {};
  const observationTimes = {};
  const metricUpdates = [];
  let measuredThisRun = false;

  for (const key of METRIC_KEYS) {
    const oldValue = Number(previousMetrics[key]) || 0;
    const previousTime = Number(previousTimes[key]);
    const hasPreviousTime = Number.isFinite(previousTime) && previousTime < now;
    const newValue = observed[key];
    if (Number.isFinite(newValue) && newValue >= 0) {
      if (!hasPreviousTime) {
        current[key] = newValue;
        observationTimes[key] = now;
      } else if (newValue >= oldValue) {
        current[key] = newValue;
        observationTimes[key] = now;
        metricUpdates.push({ key, delta: newValue - oldValue, start: previousTime, end: now });
        measuredThisRun = true;
      } else {
        current[key] = oldValue;
        observationTimes[key] = previousTime;
        warnings.push(`${key} counter decreased; previous value retained`);
      }
    } else {
      current[key] = oldValue;
      if (Number.isFinite(previousTime)) observationTimes[key] = previousTime;
    }
  }

  const lifetime = grouped(current);
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const displayEndHour = currentHour - HOUR_MS;
  const displayStartHour = displayEndHour - (HISTORY_HOURS - 1) * HOUR_MS;
  const historyByHour = new Map();
  if (Array.isArray(previousState.h)) {
    for (const row of previousState.h) {
      if (
        Array.isArray(row) &&
        row.length === 10 &&
        Number.isSafeInteger(row[0]) &&
        row[0] % HOUR_MS === 0 &&
        row.slice(1, 9).every((value) => Number.isSafeInteger(value) && value >= 0)
      ) historyByHour.set(row[0], [...row]);
    }
  }
  const coveredHours = new Set(
    Array.isArray(previousState.c)
      ? previousState.c.filter((timestamp) => (
        Number.isSafeInteger(timestamp) && timestamp % HOUR_MS === 0
      ))
      : [],
  );
  for (const update of metricUpdates) {
    allocateMetricDelta(
      historyByHour,
      coveredHours,
      update.key,
      update.delta,
      update.start,
      update.end,
      displayStartHour,
      currentHour,
    );
  }
  if (failedSources.length) ensurePackedHour(historyByHour, displayEndHour)[9] = true;

  const history = Array.from(historyByHour.values())
    .filter((row) => row[0] >= displayStartHour && row[0] <= currentHour)
    .sort((left, right) => left[0] - right[0]);
  const retainedCoveredHours = Array.from(coveredHours)
    .filter((timestamp) => timestamp >= displayStartHour && timestamp <= currentHour)
    .sort((left, right) => left - right);

  const expanded = history.map(unpackedHour);
  const expandedByHour = new Map(expanded.map((item) => [item.timestamp, item]));
  const displayHours = Array.from({ length: HISTORY_HOURS }, (_unused, index) => {
    const timestamp = displayEndHour - (HISTORY_HOURS - 1 - index) * HOUR_MS;
    return expandedByHour.get(timestamp) || unpackedHour(emptyPackedHour(timestamp));
  });
  const rollingSources = { github: 0, crates: 0, homebrew: 0, docker: 0 };
  const rollingPlatforms = { windows: 0, macos: 0, linux: 0, unknown: 0 };
  for (const displayHour of displayHours) {
    for (const key of Object.keys(rollingSources)) rollingSources[key] += displayHour.sources[key];
    for (const key of Object.keys(rollingPlatforms)) rollingPlatforms[key] += displayHour.platforms[key];
  }

  const rollingTotal = sum(rollingSources);
  const latest = displayHours[displayHours.length - 1];
  const latestTotal = sum(latest.sources);
  const timeZone = localTimeZone(input);
  const displayedHourlyTotals = displayHours.map((item) => sum(item.sources));
  const observedMaxHourly = Math.max(0, ...displayedHourlyTotals);
  const positiveHourlyTotals = displayedHourlyTotals.filter((value) => value > 0);
  const observedMinPositiveHourly = positiveHourlyTotals.length
    ? Math.min(...positiveHourlyTotals)
    : 0;
  const maxHourly = Math.max(1, observedMaxHourly);
  const minHourlyHeight = observedMinPositiveHourly > 0
    ? Math.max(
      CHART_MIN_HEIGHT_PERCENT,
      Math.round((observedMinPositiveHourly / maxHourly) * 100),
    )
    : 0;
  const showChartMin = observedMinPositiveHourly > 0 &&
    observedMinPositiveHourly !== observedMaxHourly &&
    minHourlyHeight <= 100 - Y_AXIS_LABEL_GAP_PERCENT;
  const hourly = displayHours.map((item, index) => {
    const value = sum(item.sources);
    const hourLabel = formattedHour(item.timestamp, timeZone);
    return {
      value,
      formatted: value.toLocaleString("en-US"),
      height: value > 0
        ? Math.max(CHART_MIN_HEIGHT_PERCENT, Math.round((value / maxHourly) * 100))
        : 0,
      has_errors: item.hasErrors,
      show_error_bar: item.hasErrors && value > 0,
      show_error_icon: item.hasErrors && value === 0,
      hour_label: hourLabel,
      axis_label: (index + 1) % 3 === 0 ? hourLabel : "",
    };
  });

  const allMetricsReady = METRIC_KEYS.every((key) => Number.isFinite(observationTimes[key]));
  const hasMeasuredInterval = previousState.r === true || measuredThisRun;
  const sourceRows = [
    rowData("GitHub", rollingSources.github, latest.sources.github, rollingTotal),
    rowData("crates.io", rollingSources.crates, latest.sources.crates, rollingTotal),
    rowData("Homebrew", rollingSources.homebrew, latest.sources.homebrew, rollingTotal),
    rowData("Docker", rollingSources.docker, latest.sources.docker, rollingTotal),
  ];
  const platformRows = [
    rowData("Windows", rollingPlatforms.windows, latest.platforms.windows, rollingTotal),
    rowData("macOS", rollingPlatforms.macos, latest.platforms.macos, rollingTotal),
    rowData("Linux", rollingPlatforms.linux, latest.platforms.linux, rollingTotal),
    rowData("Unknown", rollingPlatforms.unknown, latest.platforms.unknown, rollingTotal),
  ];
  const failedSourceNames = Array.from(new Set(failedSources));
  const warningStatus = failedSourceNames.length
    ? `Failed: ${failedSourceNames.join(", ")}`
    : (warnings.length ? `Warning: ${warnings[0]}` : "");
  const lifetimeTotal = sum(lifetime.sources);

  return {
    lifetime: lifetimeTotal,
    lifetime_formatted: lifetimeTotal.toLocaleString("en-US"),
    latest_hour: latestTotal,
    latest_hour_formatted: latestTotal.toLocaleString("en-US"),
    rolling_24h: rollingTotal,
    rolling_24h_formatted: rollingTotal.toLocaleString("en-US"),
    source_rows: sourceRows,
    platform_rows: platformRows,
    hourly,
    chart_max_formatted: observedMaxHourly > 0 ? observedMaxHourly.toLocaleString("en-US") : "",
    chart_min_formatted: observedMinPositiveHourly > 0
      ? observedMinPositiveHourly.toLocaleString("en-US")
      : "",
    chart_min_height: minHourlyHeight,
    show_chart_min: showChartMin,
    ready: allMetricsReady && hasMeasuredInterval,
    baseline_only: allMetricsReady && !hasMeasuredInterval,
    warning_status: warningStatus,
    has_warnings: warnings.length > 0,
    updated_at: formattedUpdatedAt(now, timeZone),
    trmnl_state: {
      v: STATE_VERSION,
      m: current,
      t: observationTimes,
      h: history,
      c: retainedCoveredHours,
      r: hasMeasuredInterval,
    },
  };
}

if (typeof module !== "undefined") {
  module.exports = { run };
}
