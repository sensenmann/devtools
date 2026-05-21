from __future__ import annotations

import os
import tomllib
from pathlib import Path

from devtools.models import AppConfig, DiscoveryConfig, ScriptsConfig


DEFAULT_CONFIG_FILENAME = "devtools.toml"


def resolve_config_path(config_path: str | None = None, cwd: Path | None = None) -> Path:
    if config_path:
        return Path(config_path).expanduser().resolve()
    base_dir = (cwd or Path.cwd()).resolve()
    return base_dir / DEFAULT_CONFIG_FILENAME


def load_config(config_path: str | None = None, cwd: Path | None = None) -> AppConfig:
    resolved = resolve_config_path(config_path=config_path, cwd=cwd)
    with resolved.open("rb") as handle:
        raw = tomllib.load(handle)

    discovery_raw = raw.get("discovery", {})
    scripts_raw = raw.get("scripts", {})

    roots = [
        Path(os.path.expanduser(item)).resolve()
        for item in discovery_raw.get("roots", ["~/Develop"])
    ]
    cache_file = Path(discovery_raw.get("cache_file", ".devtools-project-cache.json"))
    if not cache_file.is_absolute():
        cache_file = (resolved.parent / cache_file).resolve()
    scripts_dir = Path(scripts_raw.get("directory", "scripts"))
    if not scripts_dir.is_absolute():
        scripts_dir = (resolved.parent / scripts_dir).resolve()

    discovery = DiscoveryConfig(
        roots=roots,
        include_patterns=list(discovery_raw.get("include_patterns", [])),
        exclude_patterns=list(discovery_raw.get("exclude_patterns", [])),
        project_types=list(discovery_raw.get("project_types", ["maven", "node", "python"])),
        cache_file=cache_file,
    )
    scripts = ScriptsConfig(directory=scripts_dir)
    return AppConfig(config_path=resolved, discovery=discovery, scripts=scripts)
