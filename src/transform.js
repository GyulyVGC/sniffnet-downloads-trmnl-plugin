const METRIC_KEYS = ["gw", "gm", "gl", "gu", "c", "b", "d"];
const HOUR_MS = 60 * 60 * 1000;
const HISTORY_HOURS = 24;

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
    signal: AbortSignal.timeout(3500),
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
    warnings.push(`GitHub unavailable${detail ? ` (${detail})` : ""}`);
  }

  if (results.crates.status === "fulfilled") {
    const count = Number(results.crates.value && results.crates.value.crate && results.crates.value.crate.downloads);
    if (Number.isFinite(count) && count >= 0) metrics.c = count;
    else warnings.push("crates.io returned an invalid count");
  } else {
    warnings.push("crates.io unavailable");
  }

  for (const [source, key] of [["homebrew", "b"], ["docker", "d"]]) {
    if (results[source].status === "fulfilled") {
      try {
        metrics[key] = packageDownloadCount(results[source].value);
      } catch (error) {
        warnings.push(`${source} returned an invalid count`);
      }
    } else {
      warnings.push(`${source} unavailable`);
    }
  }

  return { metrics, warnings };
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

function packedHour(timestamp, sources, platforms) {
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
  ];
}

function unpackedHour(row) {
  return {
    timestamp: row[0],
    sources: { github: row[1], crates: row[2], homebrew: row[3], docker: row[4] },
    platforms: { windows: row[5], macos: row[6], linux: row[7], unknown: row[8] },
  };
}

function addPacked(target, addition) {
  for (let index = 1; index < target.length; index += 1) {
    target[index] += addition[index];
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
    width: value > 0 ? Math.max(2, percent) : 0,
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
  const previousState = safeState(input);
  const previousMetrics = previousState.m && typeof previousState.m === "object" ? previousState.m : {};
  const initialized = new Set(Array.isArray(previousState.i) ? previousState.i : []);
  const { metrics: observed, warnings } = await collect(input || {});
  const current = {};
  const changes = {};

  for (const key of METRIC_KEYS) {
    const oldValue = Number(previousMetrics[key]) || 0;
    const newValue = observed[key];
    if (Number.isFinite(newValue) && newValue >= 0) {
      if (!initialized.has(key)) {
        current[key] = newValue;
        changes[key] = 0;
        initialized.add(key);
      } else if (newValue >= oldValue) {
        current[key] = newValue;
        changes[key] = newValue - oldValue;
      } else {
        current[key] = oldValue;
        changes[key] = 0;
        warnings.push(`${key} counter decreased; previous value retained`);
      }
    } else {
      current[key] = oldValue;
      changes[key] = 0;
    }
  }

  const lifetime = grouped(current);
  const delta = grouped(changes);
  const now = Date.now();
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  let history = Array.isArray(previousState.h)
    ? previousState.h.filter((row) => Array.isArray(row) && row.length === 9 && Number.isFinite(row[0]))
    : [];
  const sample = packedHour(hour, delta.sources, delta.platforms);

  if (history.length && history[history.length - 1][0] === hour) {
    addPacked(history[history.length - 1], sample);
  } else {
    history.push(sample);
  }
  history = history.filter((row) => row[0] >= hour - (HISTORY_HOURS - 1) * HOUR_MS).slice(-HISTORY_HOURS);

  const expanded = history.map(unpackedHour);
  const expandedByHour = new Map(expanded.map((item) => [item.timestamp, item]));
  const displayHours = Array.from({ length: HISTORY_HOURS }, (_unused, index) => {
    const timestamp = hour - (HISTORY_HOURS - 1 - index) * HOUR_MS;
    return expandedByHour.get(timestamp) || unpackedHour(packedHour(
      timestamp,
      { github: 0, crates: 0, homebrew: 0, docker: 0 },
      { windows: 0, macos: 0, linux: 0, unknown: 0 },
    ));
  });
  const rollingSources = { github: 0, crates: 0, homebrew: 0, docker: 0 };
  const rollingPlatforms = { windows: 0, macos: 0, linux: 0, unknown: 0 };
  for (const sampleHour of expanded) {
    for (const key of Object.keys(rollingSources)) rollingSources[key] += sampleHour.sources[key];
    for (const key of Object.keys(rollingPlatforms)) rollingPlatforms[key] += sampleHour.platforms[key];
  }

  const rollingTotal = sum(rollingSources);
  const latest = expanded.length ? expanded[expanded.length - 1] : unpackedHour(packedHour(hour, delta.sources, delta.platforms));
  const latestTotal = sum(latest.sources);
  const timeZone = localTimeZone(input);
  const observedMaxHourly = Math.max(0, ...displayHours.map((item) => sum(item.sources)));
  const maxHourly = Math.max(1, observedMaxHourly);
  const hourly = displayHours.map((item) => {
    const value = sum(item.sources);
    return {
      value,
      formatted: value.toLocaleString("en-US"),
      height: value > 0 ? Math.max(4, Math.round((value / maxHourly) * 100)) : 0,
      hour_label: formattedHour(item.timestamp, timeZone),
    };
  });

  const allMetricsReady = METRIC_KEYS.every((key) => initialized.has(key));
  const hasMeasuredInterval = history.length > 1 || latestTotal > 0;
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

  return {
    lifetime: sum(lifetime.sources),
    lifetime_formatted: sum(lifetime.sources).toLocaleString("en-US"),
    latest_hour: latestTotal,
    latest_hour_formatted: latestTotal.toLocaleString("en-US"),
    rolling_24h: rollingTotal,
    rolling_24h_formatted: rollingTotal.toLocaleString("en-US"),
    average_hour_formatted: Math.round(rollingTotal / Math.max(1, expanded.length)).toLocaleString("en-US"),
    source_rows: sourceRows,
    platform_rows: platformRows,
    hourly,
    chart_max_formatted: observedMaxHourly > 0 ? observedMaxHourly.toLocaleString("en-US") : "",
    chart_mid_formatted: observedMaxHourly > 1
      ? Math.ceil(observedMaxHourly / 2).toLocaleString("en-US")
      : "",
    axis_compact: [hourly[0].hour_label, hourly[12].hour_label, hourly[23].hour_label],
    ready: allMetricsReady && hasMeasuredInterval,
    baseline_only: allMetricsReady && !hasMeasuredInterval,
    status: warnings.length ? warnings.join("; ") : "All sources online",
    has_warnings: warnings.length > 0,
    updated_at: formattedUpdatedAt(now, timeZone),
    trmnl_state: {
      m: current,
      i: Array.from(initialized),
      h: history,
    },
  };
}

if (typeof module !== "undefined") {
  module.exports = { run, githubPlatform, packageDownloadCount, formattedUpdatedAt };
}
