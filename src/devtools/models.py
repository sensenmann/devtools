from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


PROJECT_MARKERS: dict[str, str] = {
    "maven": "pom.xml",
    "node": "package.json",
    "python": "pyproject.toml",
}


@dataclass(slots=True)
class DiscoveryConfig:
    roots: list[Path]
    include_patterns: list[str]
    exclude_patterns: list[str]
    project_types: list[str]
    cache_file: Path


@dataclass(slots=True)
class ScriptsConfig:
    directory: Path


@dataclass(slots=True)
class AppConfig:
    config_path: Path
    discovery: DiscoveryConfig
    scripts: ScriptsConfig


@dataclass(slots=True)
class Project:
    name: str
    path: Path
    project_type: str
    marker: str
    project_types: list[str] = field(default_factory=list)

    @property
    def identity(self) -> str:
        return f"{self.name}:{self.path}"


@dataclass(slots=True)
class ScriptDefinition:
    script_id: str
    name: str
    description: str
    project_types: list[str]
    entry: str
    directory: Path
    manifest_path: Path
    default_args: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ScriptContext:
    config_path: Path
    script: ScriptDefinition
    project: Project
    args: dict[str, Any]
    run_id: str


@dataclass(slots=True)
class ExecutionResult:
    project: Project
    script: ScriptDefinition
    success: bool
    message: str
    output: str
    error: str
