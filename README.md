# devtools

`devtools` is a Python-based utility for discovering projects, listing registered maintenance scripts, and executing those scripts through a CLI or interactive TUI.

## Run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
python -m devtools --help
python -m devtools tui
```

## Configuration

The repo-local config file lives at `devtools.toml`.

## Scripts

Scripts live below `scripts/<script-id>/` and need a `manifest.toml` plus the referenced Python entry file.

