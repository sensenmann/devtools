from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from devtools.models import ScriptContext


def run_node_audit_fix(context: ScriptContext) -> dict[str, object]:
    project_root = context.project.path.resolve()
    npm_path = shutil.which("npm")
    if npm_path is None:
        return {"success": False, "message": "npm was not found on PATH."}

    package_dirs = find_project_file_dirs(project_root, "package.json")
    if not package_dirs:
        return {"success": False, "message": "No package.json files found below the selected project."}

    registry = str(context.args.get("registry", "https://registry.npmjs.org"))
    force = bool(context.args.get("force", False))
    command = [npm_path, "audit", "fix"]
    if force:
        command.append("--force")
    command.append(f"--registry={registry}")
    return _run_command_across_dirs(
        project_root=project_root,
        target_dirs=package_dirs,
        command=command,
        success_label="npm audit fix",
    )


def run_maven_dependency_update(context: ScriptContext) -> dict[str, object]:
    project_root = context.project.path.resolve()
    mvn_path = shutil.which("mvn")
    if mvn_path is None:
        return {"success": False, "message": "mvn was not found on PATH."}

    pom_dirs = find_project_file_dirs(project_root, "pom.xml")
    if not pom_dirs:
        return {"success": False, "message": "No pom.xml files found below the selected project."}

    allow_major_updates = bool(context.args.get("allow_major_updates", False))
    command = [
        mvn_path,
        "versions:use-latest-releases",
        "-DgenerateBackupPoms=false",
    ]
    if not allow_major_updates:
        command.append("-DallowMajorUpdates=false")
    command.extend(["-f", "pom.xml"])
    return _run_command_across_dirs(
        project_root=project_root,
        target_dirs=pom_dirs,
        command=command,
        success_label="maven dependency update",
    )


def find_package_dirs(project_root: Path) -> list[Path]:
    return find_project_file_dirs(project_root, "package.json")


def find_project_file_dirs(project_root: Path, filename: str) -> list[Path]:
    discovered: list[Path] = []
    for current_root, dirnames, filenames in os.walk(project_root):
        current_path = Path(current_root)
        dirnames[:] = [dirname for dirname in dirnames if dirname not in {"node_modules", ".git", "dist", "target"}]
        if filename in filenames:
            discovered.append(current_path.resolve())
    return sorted(discovered, key=lambda item: item.as_posix())


def _run_command_across_dirs(
    project_root: Path,
    target_dirs: list[Path],
    command: list[str],
    success_label: str,
) -> dict[str, object]:
    failures: list[str] = []
    for target_dir in target_dirs:
        relative_dir = target_dir.relative_to(project_root)
        label = "." if str(relative_dir) == "." else relative_dir.as_posix()
        print(f"Running in {label}: {' '.join(command)}")

        result = subprocess.run(
            command,
            cwd=target_dir,
            capture_output=True,
            text=True,
            check=False,
        )

        if result.stdout.strip():
            print(result.stdout.rstrip())
        if result.stderr.strip():
            print(result.stderr.rstrip())
        if result.returncode != 0:
            failures.append(label)
            print(f"Command failed in {label} with exit code {result.returncode}")

    if failures:
        summary = ", ".join(failures)
        return {
            "success": False,
            "message": f"{success_label} failed in {len(failures)} location(s): {summary}",
        }
    return {
        "success": True,
        "message": f"{success_label} completed in {len(target_dirs)} location(s).",
    }
