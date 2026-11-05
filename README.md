# Sniffnet downloads for TRMNL

An hourly, serverless download dashboard for Sniffnet on TRMNL e-ink displays.

The plugin displays:

- all-time downloads;
- the latest hourly sample and rolling 24-hour total;
- a 24-sample hourly chart;
- hourly and rolling 24-hour breakdowns by source;
- hourly and rolling 24-hour breakdowns by platform.

## Data sources

- GitHub release assets: exact source and platform classification from asset names;
- crates.io: exact source, platform reported as `Unknown`;
- Homebrew: counted as macOS, matching Sniffnet's existing published statistics;
- GHCR/Docker: counted as Linux.

The upstream services expose cumulative counters rather than timestamped download events. Hourly values are therefore differences between consecutive snapshots. A delayed refresh or delayed upstream update can make one bucket larger than the next.

The first refresh captures a baseline and intentionally reports zero new downloads. TRMNL Saved State retains the latest 24 hourly buckets.

No API key is required. An optional read-only GitHub token can be configured if the public GitHub API rate limit is encountered.

## Develop locally

Docker is the only requirement:

```sh
docker run --rm --pull=always -p 4567:4567 -v "$PWD:/plugin" trmnl/trmnlp serve
```

Open <http://localhost:4567>. The preview reloads whenever a file under `src/` changes.

Useful checks:

```sh
docker run --rm -v "$PWD:/plugin" trmnl/trmnlp lint
docker run --rm -v "$PWD:/plugin" trmnl/trmnlp test
docker run --rm -v "$PWD:/plugin" trmnl/trmnlp build --png
```

## Deploy

The generated GitHub Actions workflow validates pull requests and deploys commits to `main`. Add `TRMNL_API_KEY` under **Repository settings → Secrets and variables → Actions** before the first deployment.

Never commit a TRMNL or GitHub API key to this repository.
