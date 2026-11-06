# Sniffnet downloads plugin for TRMNL

A serverless download dashboard for Sniffnet on TRMNL e-ink displays.

The plugin shows:

- all-time downloads
- rolling 24-hour download statistics
- hourly and rolling 24-hour breakdowns by source
- hourly and rolling 24-hour breakdowns by platform

The dashboard is updated once per hour.

## Develop locally

Docker is the only requirement:

```sh
docker run --rm --pull=always -p 4567:4567 -v "$PWD:/plugin" trmnl/trmnlp serve
```

Open <http://localhost:4567>.
The preview reloads whenever a file under `src/` changes.

Useful checks:

```sh
node --test tests/transform_test.js
node --test tests/ios_widget_test.js
docker run --rm -v "$PWD:/plugin" trmnl/trmnlp lint
docker run --rm -v "$PWD:/plugin" trmnl/trmnlp test
docker run --rm -v "$PWD:/plugin" trmnl/trmnlp build --png
```

## Deploy

This repo's GitHub Actions workflow automatically deploys commits to TRMNL.
Add `TRMNL_API_KEY` under _Repository settings → Secrets and variables → Actions_ before the first deployment.

## iPhone widget

See the [iOS widget instructions](ios/README.md) for a Scriptable widget that mirrors the current TRMNL screen on an iPhone Home Screen.
