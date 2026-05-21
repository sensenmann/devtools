from __future__ import annotations

from pathlib import Path

from devtools.config import load_config
from devtools.discovery import discover_explicit_projects, discover_projects, filter_projects
from devtools.executor import run_script_for_projects
from devtools.models import AppConfig, ExecutionResult, Project, ScriptDefinition
from devtools.registry import applicable_scripts, get_script_by_id, load_scripts


class DevtoolsService:
    def __init__(self, config: AppConfig) -> None:
        self.config = config

    @classmethod
    def from_path(cls, config_path: str | None = None) -> "DevtoolsService":
        return cls(load_config(config_path=config_path))

    def list_projects(
        self,
        explicit_paths: list[str] | None = None,
        project_type: str | None = None,
        name_filter: str | None = None,
        refresh: bool = False,
    ) -> list[Project]:
        if explicit_paths:
            projects = discover_explicit_projects(self.config, [Path(item) for item in explicit_paths])
        else:
            projects = discover_projects(self.config, refresh=refresh)
        return filter_projects(projects, project_type=project_type, name_filter=name_filter)

    def refresh_projects(self) -> list[Project]:
        return discover_projects(self.config, refresh=True)

    def list_scripts(self, projects: list[Project] | None = None) -> list[ScriptDefinition]:
        scripts = load_scripts(self.config)
        if projects is None:
            return scripts
        return applicable_scripts(scripts, projects)

    def run_script(
        self,
        script_id: str,
        projects: list[Project],
        cli_args: dict[str, object] | None = None,
        event_callback=None,
    ) -> list[ExecutionResult]:
        scripts = load_scripts(self.config)
        script = get_script_by_id(scripts, script_id)
        if script is None:
            raise ValueError(f"Unknown script id: {script_id}")
        return run_script_for_projects(
            self.config,
            script,
            projects,
            cli_args=cli_args,
            event_callback=event_callback,
        )
