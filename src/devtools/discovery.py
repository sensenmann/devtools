from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

from devtools.models import AppConfig, PROJECT_MARKERS, Project


def detect_project_type(project_path: Path, enabled_types: list[str]) -> tuple[str, str] | None:
    for project_type in enabled_types:
        marker = PROJECT_MARKERS.get(project_type)
        if marker and (project_path / marker).exists():
            return project_type, marker
    return None


def detect_project_types_recursive(project_path: Path, enabled_types: list[str]) -> list[str]:
    found: list[str] = []
    remaining = set(enabled_types)
    for current_root, dirnames, filenames in _walk_project_tree(project_path):
        filename_set = set(filenames)
        for project_type in enabled_types:
            if project_type not in remaining:
                continue
            marker = PROJECT_MARKERS.get(project_type)
            if marker and marker in filename_set:
                found.append(project_type)
                remaining.remove(project_type)
        if not remaining:
            break
    return found


def discover_projects(config: AppConfig, roots: list[Path] | None = None, refresh: bool = False) -> list[Project]:
    if refresh or not config.discovery.cache_file.exists():
        projects = rebuild_project_cache(config, roots=roots)
    else:
        projects = load_project_cache(config)
    return sorted(projects, key=lambda item: (item.name.lower(), item.path.as_posix()))


def rebuild_project_cache(config: AppConfig, roots: list[Path] | None = None) -> list[Project]:
    scan_roots = roots or config.discovery.roots
    projects: dict[str, Project] = {}
    for root in scan_roots:
        if not root.exists():
            continue
        for child in sorted(root.iterdir(), key=lambda item: item.name.lower()):
            if not child.is_dir():
                continue
            if _should_skip_path(child, config):
                continue
            if not _is_included(child, config):
                continue
            detected_types = detect_project_types_recursive(child, config.discovery.project_types)
            if not detected_types:
                continue
            project_type = detected_types[0]
            marker = PROJECT_MARKERS[project_type]
            project = Project(
                name=child.name,
                path=child.resolve(),
                project_type=project_type,
                marker=marker,
                project_types=detected_types,
            )
            projects[project.identity] = project

    _write_project_cache(config, list(projects.values()))
    return list(projects.values())


def load_project_cache(config: AppConfig) -> list[Project]:
    cache_file = config.discovery.cache_file
    with cache_file.open("r", encoding="utf-8") as handle:
        raw = json.load(handle)

    projects: list[Project] = []
    for item in raw.get("projects", []):
        path = Path(item["path"]).expanduser().resolve()
        detected = detect_project_type(path, config.discovery.project_types)
        if detected is None:
            continue
        project_types = detect_project_types_recursive(path, config.discovery.project_types)
        projects.append(
            Project(
                name=str(item["name"]),
                path=path,
                project_type=str(item["project_type"]),
                marker=str(item["marker"]),
                project_types=[str(value) for value in item.get("project_types", project_types or [str(item["project_type"])])],
            )
        )
    return projects


def discover_explicit_projects(config: AppConfig, paths: list[Path]) -> list[Project]:
    projects: list[Project] = []
    for path in paths:
        resolved = path.expanduser().resolve()
        detected = detect_project_type(resolved, config.discovery.project_types)
        if detected is None:
            continue
        project_type, marker = detected
        projects.append(
            Project(
                name=resolved.name,
                path=resolved,
                project_type=project_type,
                marker=marker,
                project_types=detect_project_types_recursive(resolved, config.discovery.project_types),
            )
        )
    return sorted(projects, key=lambda item: (item.name.lower(), item.path.as_posix()))


def filter_projects(
    projects: list[Project],
    project_type: str | None = None,
    name_filter: str | None = None,
) -> list[Project]:
    filtered = projects
    if project_type:
        filtered = [project for project in filtered if project.project_type == project_type]
    if name_filter:
        lowered = name_filter.lower()
        filtered = [
            project
            for project in filtered
            if lowered in project.name.lower() or lowered in project.path.as_posix().lower()
        ]
    return filtered


def _write_project_cache(config: AppConfig, projects: list[Project]) -> None:
    cache_file = config.discovery.cache_file
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "roots": [root.as_posix() for root in config.discovery.roots],
        "projects": [
            {
                **asdict(project),
                "path": project.path.as_posix(),
            }
            for project in sorted(projects, key=lambda item: (item.name.lower(), item.path.as_posix()))
        ],
    }
    cache_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _is_included(path: Path, config: AppConfig) -> bool:
    include_patterns = config.discovery.include_patterns
    if not include_patterns:
        return True
    return any(path.match(pattern) for pattern in include_patterns)


def _should_skip_path(path: Path, config: AppConfig) -> bool:
    path_text = path.as_posix()
    return any(
        path.match(pattern) or path_text.endswith(pattern.replace("**/", ""))
        for pattern in config.discovery.exclude_patterns
    )


def _walk_project_tree(project_root: Path):
    import os

    for current_root, dirnames, filenames in os.walk(project_root):
        current_path = Path(current_root)
        dirnames[:] = [
            dirname
            for dirname in dirnames
            if not _is_runtime_skip_dir(current_path / dirname)
        ]
        yield current_root, dirnames, filenames


def _is_runtime_skip_dir(path: Path) -> bool:
    return path.name in {"node_modules", ".git", "dist", "target", ".angular", ".cache", ".next"}
