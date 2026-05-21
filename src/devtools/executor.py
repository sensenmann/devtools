from __future__ import annotations

import contextlib
import importlib.util
import io
import uuid
from pathlib import Path
from typing import Callable

from devtools.models import AppConfig, ExecutionResult, Project, ScriptContext, ScriptDefinition


def run_script_for_projects(
    config: AppConfig,
    script: ScriptDefinition,
    projects: list[Project],
    cli_args: dict[str, object] | None = None,
    event_callback: Callable[[str], None] | None = None,
) -> list[ExecutionResult]:
    results: list[ExecutionResult] = []
    for project in projects:
        if event_callback:
            event_callback(f"[start] {script.script_id} -> {project.path}")
        result = run_script_for_project(config, script, project, cli_args=cli_args)
        results.append(result)
        if event_callback:
            prefix = "ok" if result.success else "fail"
            detail = result.message if result.message else result.error
            event_callback(f"[{prefix}] {project.path} :: {detail}")
    return results


def run_script_for_project(
    config: AppConfig,
    script: ScriptDefinition,
    project: Project,
    cli_args: dict[str, object] | None = None,
) -> ExecutionResult:
    args = dict(script.default_args)
    if cli_args:
        args.update(cli_args)

    context = ScriptContext(
        config_path=config.config_path,
        script=script,
        project=project,
        args=args,
        run_id=uuid.uuid4().hex,
    )
    stdout = io.StringIO()
    stderr = io.StringIO()
    try:
        runner = _load_entry(script)
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            response = runner(context)
        success = bool(response.get("success", True)) if isinstance(response, dict) else True
        message = str(response.get("message", "")) if isinstance(response, dict) else ""
        return ExecutionResult(
            project=project,
            script=script,
            success=success,
            message=message,
            output=stdout.getvalue(),
            error=stderr.getvalue(),
        )
    except Exception as exc:  # noqa: BLE001
        return ExecutionResult(
            project=project,
            script=script,
            success=False,
            message="",
            output=stdout.getvalue(),
            error=f"{stderr.getvalue()}{exc}",
        )


def _load_entry(script: ScriptDefinition):
    module_rel, _, function_name = script.entry.partition(":")
    if not module_rel or not function_name:
        raise ValueError(f"Invalid entry definition for {script.script_id}: {script.entry}")

    module_path = (script.directory / module_rel).resolve()
    if not module_path.exists():
        raise FileNotFoundError(f"Entry module not found: {module_path}")

    module_name = f"devtools_script_{script.script_id}"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load module from {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    entry = getattr(module, function_name, None)
    if entry is None:
        raise AttributeError(f"Function {function_name} not found in {module_path}")
    return entry

