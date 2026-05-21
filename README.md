# devtools

`devtools` is a TypeScript-based utility for discovering projects, listing registered maintenance scripts, and executing those scripts through a CLI or interactive TUI.

## Installation
```bash
npm i
npx playwright install chromium 
```

## Run

```bash
node src/cli.ts --help
node src/cli.ts tui
node src/cli.ts schedule-run
```

`schedule-run` starts the polling scheduler for saved scheduled jobs.

## Configuration

The repo-local config file lives at `devtools.toml`.

## Scripts

Scripts live below `scripts/<script-id>/` and contain a `manifest.toml` plus a local `script.ts` module.
