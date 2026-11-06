const test = require("node:test");
const assert = require("node:assert/strict");

const { run } = require("../src/transform");

const HOUR_MS = 60 * 60 * 1000;
const METRIC_KEYS = ["gw", "gm", "gl", "gu", "c", "b", "d"];
const at = (hour, minute = 0) => Date.UTC(2026, 10, 6, hour, minute);
const input = (state) => ({
  trmnl: {
    state,
    user: { time_zone_iana: "UTC" },
  },
});
const rowTotal = (row) => row.slice(1, 5).reduce((total, value) => total + value, 0);

test("hourly transform state and chart behavior", async (suite) => {
  const originalDateNow = Date.now;
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;
  let now;
  let failCrates;
  let counts;
  let errorLogs;

  const reset = () => {
    now = at(9, 5);
    failCrates = false;
    counts = { github: 100, crates: 40, homebrew: 20, docker: 10 };
    errorLogs = [];
  };

  const populatedState = (history) => ({
    v: 2,
    m: { gw: 100, gm: 0, gl: 0, gu: 0, c: 40, b: 20, d: 10 },
    t: Object.fromEntries(METRIC_KEYS.map((key) => [key, at(9, 30)])),
    h: history,
    c: history.map((row) => row[0]),
    r: true,
  });

  Date.now = () => now;
  console.error = (...args) => errorLogs.push(args.join(" "));
  global.fetch = async (url) => {
    if (url.includes("crates.io") && failCrates) throw new Error("mock failure");

    const response = { ok: true, status: 200, statusText: "OK" };
    if (url.includes("api.github.com")) {
      response.json = async () => [{
        assets: [{ name: "Sniffnet_Windows.msi", download_count: counts.github }],
      }];
    }
    if (url.includes("crates.io")) {
      response.json = async () => ({ crate: { downloads: counts.crates } });
    }
    if (url.includes("homebrew-core")) {
      response.text = async () => (
        `<span>Total downloads</span><h3 title="${counts.homebrew}">`
      );
    }
    if (url.includes("pkgs/container/sniffnet")) {
      response.text = async () => (
        `<span>Total downloads</span><h3 title="${counts.docker}">`
      );
    }
    return response;
  };

  try {
    await suite.test("weights deltas across hours and hides the current partial hour", async () => {
      reset();
      const baseline = await run({});

      assert.equal(baseline.ready, false);
      assert.equal(baseline.baseline_only, true);
      assert.equal(baseline.chart_min_formatted, "");
      assert.equal(baseline.show_chart_min, false);
      assert.equal(baseline.trmnl_state.v, 2);
      assert.equal(baseline.trmnl_state.h.length, 0);

      now = at(10, 5);
      counts = { github: 110, crates: 45, homebrew: 23, docker: 12 };
      const firstInterval = await run(input(baseline.trmnl_state));

      assert.equal(firstInterval.ready, true);
      assert.equal(firstInterval.latest_hour, 19);
      assert.equal(firstInterval.hourly.at(-1).hour_label, "09");
      assert.equal(firstInterval.trmnl_state.h.find((row) => row[0] === at(9)).slice(1, 9).every(Number.isInteger), true);
      assert.equal(rowTotal(firstInterval.trmnl_state.h.find((row) => row[0] === at(9))), 19);
      assert.equal(rowTotal(firstInterval.trmnl_state.h.find((row) => row[0] === at(10))), 1);
      assert.equal(firstInterval.rolling_24h, 19);

      now = at(11, 5);
      counts = { github: 120, crates: 50, homebrew: 26, docker: 14 };
      const secondInterval = await run(input(firstInterval.trmnl_state));

      assert.equal(secondInterval.latest_hour, 20);
      assert.equal(secondInterval.hourly.at(-1).hour_label, "10");
      assert.equal(rowTotal(secondInterval.trmnl_state.h.find((row) => row[0] === at(10))), 20);
      assert.equal(rowTotal(secondInterval.trmnl_state.h.find((row) => row[0] === at(11))), 1);
      assert.equal(secondInterval.rolling_24h, 39);
    });

    await suite.test("combines both sides of an hour at minute 59 without showing the partial hour", async () => {
      reset();
      now = at(9, 59);
      const baseline = await run({});

      now = at(10, 59);
      counts.github = 160;
      const firstInterval = await run(input(baseline.trmnl_state));

      assert.equal(firstInterval.latest_hour, 1);
      assert.equal(firstInterval.hourly.at(-1).hour_label, "09");
      assert.equal(rowTotal(firstInterval.trmnl_state.h.find((row) => row[0] === at(10))), 59);
      assert.equal(firstInterval.rolling_24h, 1);

      now = at(11, 59);
      counts.github = 220;
      const secondInterval = await run(input(firstInterval.trmnl_state));

      assert.equal(secondInterval.latest_hour, 60);
      assert.equal(secondInterval.hourly.at(-1).hour_label, "10");
      assert.equal(rowTotal(secondInterval.trmnl_state.h.find((row) => row[0] === at(10))), 60);
      assert.equal(rowTotal(secondInterval.trmnl_state.h.find((row) => row[0] === at(11))), 59);
      assert.equal(secondInterval.rolling_24h, 61);
      assert.equal(secondInterval.trmnl_state.h.reduce((total, row) => total + rowTotal(row), 0), 120);
    });

    await suite.test("manual refreshes contribute once to the same completed hour", async () => {
      reset();
      const baseline = await run({});

      now = at(10, 5);
      counts.github = 160;
      const hourly = await run(input(baseline.trmnl_state));

      now = at(10, 20);
      counts.github = 175;
      const manual = await run(input(hourly.trmnl_state));
      assert.equal(manual.latest_hour, 55);
      assert.equal(rowTotal(manual.trmnl_state.h.find((row) => row[0] === at(10))), 20);

      now = at(11, 5);
      counts.github = 220;
      const completed = await run(input(manual.trmnl_state));

      assert.equal(completed.latest_hour, 60);
      assert.equal(rowTotal(completed.trmnl_state.h.find((row) => row[0] === at(10))), 60);
      assert.equal(completed.trmnl_state.h.reduce((total, row) => total + rowTotal(row), 0), 120);
    });

    await suite.test("a delayed refresh fills every overlapped completed hour", async () => {
      reset();
      const baseline = await run({});

      now = at(12, 5);
      counts.github = 280;
      const delayed = await run(input(baseline.trmnl_state));

      assert.equal(rowTotal(delayed.trmnl_state.h.find((row) => row[0] === at(9))), 55);
      assert.equal(rowTotal(delayed.trmnl_state.h.find((row) => row[0] === at(10))), 60);
      assert.equal(rowTotal(delayed.trmnl_state.h.find((row) => row[0] === at(11))), 60);
      assert.equal(rowTotal(delayed.trmnl_state.h.find((row) => row[0] === at(12))), 5);
      assert.equal(delayed.latest_hour, 60);
      assert.equal(delayed.rolling_24h, 175);
      assert.equal(delayed.trmnl_state.h.reduce((total, row) => total + rowTotal(row), 0), 180);
    });

    await suite.test("uses integer boundary rounding without losing a download", async () => {
      reset();
      const baseline = await run({});

      now = at(10, 5);
      counts.github = 107;
      const measured = await run(input(baseline.trmnl_state));
      const rows = measured.trmnl_state.h;

      assert.equal(rowTotal(rows.find((row) => row[0] === at(9))), 6);
      assert.equal(rowTotal(rows.find((row) => row[0] === at(10))), 1);
      assert.equal(rows.reduce((total, row) => total + rowTotal(row), 0), 7);
      assert.equal(rows.flatMap((row) => row.slice(1, 9)).every(Number.isInteger), true);
    });

    await suite.test("preserves totals through many jittered and manual intervals", async () => {
      reset();
      now = at(0, 5);
      const baseline = await run({});
      let state = baseline.trmnl_state;
      let totalDelta = 0;
      let seed = 0x5eed1234;

      for (let index = 0; index < 18; index += 1) {
        seed = (1664525 * seed + 1013904223) >>> 0;
        now += (5 + seed % 71) * 60 * 1000;
        seed = (1664525 * seed + 1013904223) >>> 0;
        const delta = seed % 21;
        counts.github += delta;
        totalDelta += delta;
        state = (await run(input(state))).trmnl_state;
      }

      assert.equal(state.h.reduce((total, row) => total + rowTotal(row), 0), totalDelta);
      assert.ok(state.h.length <= 25);
      for (const row of state.h) {
        assert.equal(rowTotal(row), row.slice(5, 9).reduce((total, value) => total + value, 0));
        assert.equal(row.slice(1, 9).every(Number.isInteger), true);
      }
    });

    await suite.test("bounds state and keeps only the recent share after a long outage", async () => {
      reset();
      const baseline = await run({});

      now = at(60, 5);
      counts.github = 610;
      const recovered = await run(input(baseline.trmnl_state));

      assert.equal(recovered.trmnl_state.h.length, 25);
      assert.equal(recovered.rolling_24h, 240);
      assert.equal(recovered.latest_hour, 10);
      assert.equal(rowTotal(recovered.trmnl_state.h.find((row) => row[0] === at(60))), 1);
      assert.equal(
        recovered.trmnl_state.h.reduce((total, row) => total + rowTotal(row), 0),
        241,
      );
    });

    await suite.test("retains a failed source timestamp and distributes its recovered delta", async () => {
      reset();
      const baseline = await run({});

      now = at(10, 5);
      failCrates = true;
      const failed = await run(input(baseline.trmnl_state));

      assert.equal(failed.has_warnings, true);
      assert.equal(failed.hourly.at(-1).has_errors, true);
      assert.equal(failed.trmnl_state.t.c, at(9, 5));
      assert.deepEqual(errorLogs, ["[Sniffnet Downloads] crates.io: mock failure"]);

      now = at(11, 5);
      failCrates = false;
      counts.crates = 160;
      const recovered = await run(input(failed.trmnl_state));

      assert.equal(recovered.trmnl_state.h.find((row) => row[0] === at(9))[2], 55);
      assert.equal(recovered.trmnl_state.h.find((row) => row[0] === at(10))[2], 60);
      assert.equal(recovered.trmnl_state.h.find((row) => row[0] === at(11))[2], 5);
      assert.equal(recovered.hourly.at(-2).has_errors, true);
      assert.equal(recovered.hourly.at(-1).has_errors, false);
    });

    await suite.test("resets incompatible saved state as a fresh baseline", async () => {
      reset();
      now = at(10, 5);
      const oldState = {
        m: { gw: 100, gm: 0, gl: 0, gu: 0, c: 40, b: 20, d: 10 },
        i: METRIC_KEYS,
        h: [[at(9), 1, 0, 0, 0, 1, 0, 0, 0, false]],
      };

      const result = await run(input(oldState));

      assert.equal(result.baseline_only, true);
      assert.equal(result.trmnl_state.v, 2);
      assert.deepEqual(result.trmnl_state.h, []);
    });

    await suite.test("keeps zero distinct from the chart and share visual minimums", async () => {
      reset();
      now = at(10, 30);
      const endHour = at(9);
      const history = Array.from({ length: 24 }, (_unused, index) => {
        const github = index === 0 ? 1000 : 0;
        const crates = index === 1 ? 1 : 0;
        return [
          endHour - (23 - index) * HOUR_MS,
          github, crates, 0, 0,
          github, 0, 0, crates,
          false,
        ];
      });

      const result = await run(input(populatedState(history)));
      const heights = result.hourly.map((point) => point.height);

      assert.equal(result.rolling_24h, 1001);
      assert.ok(heights.includes(100));
      assert.ok(heights.includes(4));
      assert.ok(heights.includes(0));
      assert.equal(result.source_rows.find((row) => row.name === "GitHub").percent, 100);
      assert.equal(result.source_rows.find((row) => row.name === "GitHub").width, 97);
      assert.equal(result.source_rows.find((row) => row.name === "crates.io").width, 3);
      assert.equal(result.source_rows.find((row) => row.name === "Homebrew").width, 0);
      assert.equal(result.platform_rows.find((row) => row.name === "Windows").percent, 100);
      assert.equal(result.platform_rows.find((row) => row.name === "Windows").width, 97);
      assert.equal(result.platform_rows.find((row) => row.name === "Unknown").width, 3);
      assert.equal(result.chart_min_formatted, "1");
      assert.equal(result.chart_min_height, 4);
      assert.equal(result.show_chart_min, true);
    });

    await suite.test("hides the minimum label when it would overlap the maximum", async () => {
      reset();
      now = at(10, 30);
      const endHour = at(9);
      const history = Array.from({ length: 24 }, (_unused, index) => {
        const github = index === 0 ? 100 : 90;
        return [
          endHour - (23 - index) * HOUR_MS,
          github, 0, 0, 0,
          github, 0, 0, 0,
          false,
        ];
      });

      const result = await run(input(populatedState(history)));

      assert.equal(result.chart_max_formatted, "100");
      assert.equal(result.chart_min_formatted, "90");
      assert.equal(result.chart_min_height, 90);
      assert.equal(result.show_chart_min, false);
    });

    await suite.test("aligns a small positive minimum label with the chart floor", async () => {
      reset();
      now = at(10, 30);
      const endHour = at(9);
      const history = Array.from({ length: 24 }, (_unused, index) => {
        const github = index === 0 ? 1000 : 1;
        return [
          endHour - (23 - index) * HOUR_MS,
          github, 0, 0, 0,
          github, 0, 0, 0,
          false,
        ];
      });

      const result = await run(input(populatedState(history)));

      assert.equal(Math.min(...result.hourly.map((point) => point.height)), 4);
      assert.equal(result.chart_min_formatted, "1");
      assert.equal(result.chart_min_height, 4);
      assert.equal(result.show_chart_min, true);
    });

    await suite.test("keeps an exact full share at 100 percent", async () => {
      reset();
      now = at(10, 30);
      const endHour = at(9);
      const history = Array.from({ length: 24 }, (_unused, index) => {
        const github = index === 23 ? 1 : 0;
        return [
          endHour - (23 - index) * HOUR_MS,
          github, 0, 0, 0,
          github, 0, 0, 0,
          false,
        ];
      });

      const result = await run(input(populatedState(history)));

      assert.equal(result.source_rows.find((row) => row.name === "GitHub").width, 100);
      assert.equal(result.platform_rows.find((row) => row.name === "Windows").width, 100);
    });
  } finally {
    Date.now = originalDateNow;
    global.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});
