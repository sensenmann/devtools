from __future__ import annotations

import tomllib
from pathlib import Path

from devtools.models import AppConfig, Project, ScriptDefinition


MANIFEST_NAME = "manifest.toml"


def load_scripts(config: AppConfig) -> list[ScriptDefinition]:
    scripts_dir = config.scripts.directory
    if not scripts_dir.exists():
        return []

    scripts: list[ScriptDefinition] = []
    for child in sorted(scripts_dir.iterdir()):
        if not child.is_dir():
            continue
        manifest_path = child / MANIFEST_NAME
        if not manifest_path.exists():
            continue
        scripts.append(_load_manifest(child, manifest_path))
    return scripts


def applicable_scripts(scripts: list[ScriptDefinition], projects: list[Project]) -> list[ScriptDefinition]:
    if not projects:
        return scripts
    return [
        script
        for script in scripts
        if all(set(script.project_types).intersection(set(project.project_types or [project.project_type])) for project in projects)
    ]


def get_script_by_id(scripts: list[ScriptDefinition], script_id: str) -> ScriptDefinition | None:
    for script in scripts:
        if script.script_id == script_id:
            return script
    return None


def _load_manifest(directory: Path, manifest_path: Path) -> ScriptDefinition:
    with manifest_path.open("rb") as handle:
        raw = tomllib.load(handle)

    required = ("id", "name", "description", "project_types", "entry")
    missing = [key for key in required if key not in raw]
    if missing:
        missing_fields = ", ".join(missing)
        raise ValueError(f"Missing fields in {manifest_path}: {missing_fields}")

    return ScriptDefinition(
        script_id=str(raw["id"]),
        name=str(raw["name"]),
        description=str(raw["description"]),
        project_types=[str(item) for item in raw["project_types"]],
        entry=str(raw["entry"]),
        directory=directory,
        manifest_path=manifest_path,
        default_args=dict(raw.get("default_args", {})),
    )
