from __future__ import annotations

import argparse
import json
from pathlib import Path

from devtools.service import DevtoolsService


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="devtools", description="Project maintenance runner")
    parser.add_argument("--config", help="Path to devtools TOML config")

    subparsers = parser.add_subparsers(dest="command", required=True)

    projects_parser = subparsers.add_parser("projects", help="List discovered projects")
    projects_parser.add_argument("--path", action="append", dest="paths", help="Explicit project path")
    projects_parser.add_argument("--type", dest="project_type", help="Filter by project type")
    projects_parser.add_argument("--filter", dest="name_filter", help="Filter by name/path substring")
    projects_parser.add_argument("--refresh", action="store_true", help="Refresh the project cache before listing")

    scripts_parser = subparsers.add_parser("scripts", help="List scripts")
    scripts_parser.add_argument("--path", action="append", dest="paths", help="Explicit project path")
    scripts_parser.add_argument("--refresh", action="store_true", help="Refresh the project cache before listing")

    run_parser = subparsers.add_parser("run", help="Run a script")
    run_parser.add_argument("script_id", help="Script id from the manifest")
    run_parser.add_argument("--path", action="append", dest="paths", help="Explicit project path")
    run_parser.add_argument("--type", dest="project_type", help="Filter discovered projects by type")
    run_parser.add_argument("--filter", dest="name_filter", help="Filter discovered projects by name/path")
    run_parser.add_argument("--refresh", action="store_true", help="Refresh the project cache before running")
    run_parser.add_argument(
        "--arg",
        action="append",
        default=[],
        help="Extra script argument in key=value format",
    )

    subparsers.add_parser("refresh-cache", help="Rebuild the top-level project cache")
    subparsers.add_parser("tui", help="Start the interactive terminal UI")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    service = DevtoolsService.from_path(config_path=args.config)

    if args.command == "projects":
        return _handle_projects(service, args)
    if args.command == "scripts":
        return _handle_scripts(service, args)
    if args.command == "run":
        return _handle_run(service, args)
    if args.command == "refresh-cache":
        return _handle_refresh_cache(service)
    if args.command == "tui":
        return _handle_tui(service)
    parser.error(f"Unknown command: {args.command}")
    return 2


def _handle_projects(service: DevtoolsService, args: argparse.Namespace) -> int:
    projects = service.list_projects(
        explicit_paths=args.paths,
        project_type=args.project_type,
        name_filter=args.name_filter,
        refresh=args.refresh,
    )
    for project in projects:
        print(f"{','.join(project.project_types or [project.project_type]):12} {project.name:30} {project.path}")
    return 0


def _handle_scripts(service: DevtoolsService, args: argparse.Namespace) -> int:
    projects = (
        service.list_projects(explicit_paths=args.paths, refresh=args.refresh)
        if args.paths or args.refresh
        else None
    )
    scripts = service.list_scripts(projects=projects)
    for script in scripts:
        types = ",".join(script.project_types)
        print(f"{script.script_id:18} [{types}] {script.name} - {script.description}")
    return 0


def _handle_run(service: DevtoolsService, args: argparse.Namespace) -> int:
    projects = service.list_projects(
        explicit_paths=args.paths,
        project_type=args.project_type,
        name_filter=args.name_filter,
        refresh=args.refresh,
    )
    if not projects:
        print("No matching projects found.")
        return 1

    cli_args = _parse_key_values(args.arg)
    results = service.run_script(
        script_id=args.script_id,
        projects=projects,
        cli_args=cli_args,
        event_callback=print,
    )

    failures = 0
    for result in results:
        status = "OK" if result.success else "FAIL"
        print(f"\n[{status}] {result.project.path}")
        if result.message:
            print(result.message)
        if result.output.strip():
            print(result.output.rstrip())
        if result.error.strip():
            print(result.error.rstrip())
        if not result.success:
            failures += 1
    return 1 if failures else 0


def _handle_tui(service: DevtoolsService) -> int:
    try:
        from devtools.tui import DevtoolsApp
    except ModuleNotFoundError as exc:
        missing = getattr(exc, "name", "textual")
        print(
            "TUI dependencies are not installed. "
            f"Install the missing package and retry: {missing}"
        )
        return 1

    app = DevtoolsApp(service)
    app.run()
    return 0


def _handle_refresh_cache(service: DevtoolsService) -> int:
    projects = service.refresh_projects()
    print(f"Cached {len(projects)} top-level project(s).")
    return 0


def _parse_key_values(items: list[str]) -> dict[str, object]:
    parsed: dict[str, object] = {}
    for item in items:
        key, separator, value = item.partition("=")
        if not separator:
            raise ValueError(f"Invalid --arg value: {item}")
        parsed[key] = _coerce_value(value)
    return parsed


def _coerce_value(value: str) -> object:
    lowered = value.lower()
    if lowered in {"true", "false"}:
        return lowered == "true"
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value
