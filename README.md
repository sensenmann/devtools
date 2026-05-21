# devtools

`devtools` is a TypeScript-based utility for discovering projects, listing registered maintenance scripts, and executing those scripts through a CLI or interactive TUI.

## Run

```bash
node src/cli.ts --help
node src/cli.ts tui
```

## Configuration

The repo-local config file lives at `devtools.toml`.

## Scripts

Scripts live below `scripts/<script-id>/` and need a `manifest.toml` that points to a built-in TypeScript module.
