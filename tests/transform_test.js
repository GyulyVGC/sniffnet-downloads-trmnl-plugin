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

test("hourly transform state and chart behavior", async (suite) => {
  const originalDateNow = Date.now;
  const originalFetch = global.fetch;
  let now;
  let failCrates;
  let counts;

  const reset = () => {
    now = at(9, 5);
    failCrates = false;
    counts = { github: 100, crates: 40, homebrew: 20, docker: 10 };
  };

  Date.now = () => now;
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
    await suite.test("captures a baseline, then assigns deltas to the previous hour", async () => {
      reset();
      const baseline = await run({});

      assert.equal(baseline.ready, false);
      assert.equal(baseline.baseline_only, true);
      assert.equal(baseline.trmnl_state.h.length, 1);
      assert.deepEqual(
        baseline.trmnl_state.h[0],
        [at(8), 0, 0, 0, 0, 0, 0, 0, 0, false],
      );

      now = at(10, 5);
      counts = { github: 110, crates: 45, homebrew: 23, docker: 12 };
      const measured = await run(input(baseline.trmnl_state));

      assert.equal(measured.ready, true);
      assert.equal(measured.baseline_only, false);
      assert.equal(measured.latest_hour, 20);
      assert.equal(measured.trmnl_state.h.at(-1)[0], at(9));
      assert.equal(measured.hourly.at(-1).value, 20);
    });

    await suite.test("retains an error for its hour and clears it for the next hour", async () => {
      reset();
      const baseline = await run({});

      now = at(10, 5);
      failCrates = true;
      counts = { github: 110, crates: 45, homebrew: 23, docker: 12 };
      const failed = await run(input(baseline.trmnl_state));

      assert.equal(failed.has_warnings, true);
      assert.equal(failed.hourly.at(-1).has_errors, true);
      assert.equal(failed.trmnl_state.h.at(-1)[9], true);

      now = at(10, 35);
      failCrates = false;
      counts = { github: 112, crates: 48, homebrew: 24, docker: 13 };
      const recovered = await run(input(failed.trmnl_state));

      assert.equal(recovered.hourly.at(-1).has_errors, true);
      assert.equal(recovered.trmnl_state.h.at(-1)[9], true);

      now = at(11, 5);
      const nextHour = await run(input(recovered.trmnl_state));

      assert.equal(nextHour.hourly.at(-1).has_errors, false);
      assert.equal(nextHour.trmnl_state.h.at(-1)[9], false);
    });

    await suite.test("accepts only the new ten-field hourly state", async () => {
      reset();
      now = at(10, 5);
      const legacyState = {
        m: { gw: 100, gm: 0, gl: 0, gu: 0, c: 40, b: 20, d: 10 },
        i: METRIC_KEYS,
        h: [[at(8), 1, 0, 0, 0, 1, 0, 0, 0]],
      };

      const result = await run(input(legacyState));

      assert.equal(result.trmnl_state.h.length, 1);
      assert.deepEqual(
        result.trmnl_state.h[0],
        [at(9), 0, 0, 0, 0, 0, 0, 0, 0, false],
      );
    });

    await suite.test("keeps zero distinct from the five-percent visual minimum", async () => {
      reset();
      now = at(10, 30);
      const endHour = at(9);
      const history = Array.from({ length: 24 }, (_unused, index) => {
        const github = index === 0 ? 100 : 0;
        const crates = index === 1 ? 1 : 0;
        return [
          endHour - (23 - index) * HOUR_MS,
          github, crates, 0, 0,
          github, 0, 0, crates,
          false,
        ];
      });
      const state = {
        m: { gw: 100, gm: 0, gl: 0, gu: 0, c: 40, b: 20, d: 10 },
        i: METRIC_KEYS,
        h: history,
      };

      const result = await run(input(state));
      const heights = result.hourly.map((point) => point.height);

      assert.equal(result.rolling_24h, 101);
      assert.ok(heights.includes(100));
      assert.ok(heights.includes(5));
      assert.ok(heights.includes(0));
      assert.equal(result.source_rows.find((row) => row.name === "crates.io").width, 5);
      assert.equal(result.source_rows.find((row) => row.name === "Homebrew").width, 0);
      assert.equal(result.platform_rows.find((row) => row.name === "Unknown").width, 5);
      assert.equal(result.chart_min_formatted, "0");
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
      const state = {
        m: { gw: 100, gm: 0, gl: 0, gu: 0, c: 40, b: 20, d: 10 },
        i: METRIC_KEYS,
        h: history,
      };

      const result = await run(input(state));

      assert.equal(result.chart_max_formatted, "100");
      assert.equal(result.chart_min_formatted, "90");
      assert.equal(result.chart_min_height, 90);
      assert.equal(result.show_chart_min, false);
    });
  } finally {
    Date.now = originalDateNow;
    global.fetch = originalFetch;
  }
});
