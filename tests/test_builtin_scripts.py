from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from devtools.builtin_scripts import (
    find_package_dirs,
    find_project_file_dirs,
    run_maven_dependency_update,
    run_node_audit_fix,
)
from devtools.models import Project, ScriptContext, ScriptDefinition


class BuiltinScriptsTests(unittest.TestCase):
    def test_find_package_dirs_walks_nested_projects_and_skips_node_modules(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            (root / "package.json").write_text("{}", encoding="utf-8")
            (root / "frontend").mkdir()
            (root / "frontend" / "package.json").write_text("{}", encoding="utf-8")
            (root / "node_modules").mkdir()
            (root / "node_modules" / "bad").mkdir()
            (root / "node_modules" / "bad" / "package.json").write_text("{}", encoding="utf-8")

            package_dirs = find_package_dirs(root)
            self.assertEqual(
                [path.relative_to(root).as_posix() or "." for path in package_dirs],
                [".", "frontend"],
            )

    def test_find_project_file_dirs_walks_nested_maven_projects(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            (root / "pom.xml").write_text("<project/>", encoding="utf-8")
            (root / "module-a").mkdir()
            (root / "module-a" / "pom.xml").write_text("<project/>", encoding="utf-8")
            (root / "target").mkdir()
            (root / "target" / "ignored").mkdir()
            (root / "target" / "ignored" / "pom.xml").write_text("<project/>", encoding="utf-8")

            pom_dirs = find_project_file_dirs(root, "pom.xml")
            self.assertEqual(
                [path.relative_to(root).as_posix() or "." for path in pom_dirs],
                [".", "module-a"],
            )

    @patch("devtools.builtin_scripts.shutil.which", return_value="/usr/bin/npm")
    @patch("devtools.builtin_scripts.subprocess.run")
    def test_run_node_audit_fix_runs_all_package_locations(self, run_mock: Mock, _which_mock: Mock) -> None:
        run_mock.return_value = Mock(returncode=0, stdout="ok\n", stderr="")
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            (root / "package.json").write_text("{}", encoding="utf-8")
            (root / "frontend").mkdir()
            (root / "frontend" / "package.json").write_text("{}", encoding="utf-8")

            context = _build_context(
                root,
                project_type="node",
                script_id="node_dependency_update",
                default_args={"force": False, "registry": "https://registry.npmjs.org"},
            )
            result = run_node_audit_fix(context)

            self.assertTrue(result["success"])
            self.assertEqual(run_mock.call_count, 2)
            first_command = run_mock.call_args_list[0].args[0]
            self.assertEqual(
                first_command,
                ["/usr/bin/npm", "audit", "fix", "--registry=https://registry.npmjs.org"],
            )

    @patch("devtools.builtin_scripts.shutil.which", return_value="/usr/bin/npm")
    @patch("devtools.builtin_scripts.subprocess.run")
    def test_run_node_audit_fix_adds_force_flag(self, run_mock: Mock, _which_mock: Mock) -> None:
        run_mock.return_value = Mock(returncode=0, stdout="", stderr="")
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            (root / "package.json").write_text("{}", encoding="utf-8")

            context = _build_context(
                root,
                project_type="node",
                script_id="node_dependency_update_force",
                default_args={"force": True, "registry": "https://registry.npmjs.org"},
            )
            result = run_node_audit_fix(context)

            self.assertTrue(result["success"])
            command = run_mock.call_args.args[0]
            self.assertEqual(
                command,
                ["/usr/bin/npm", "audit", "fix", "--force", "--registry=https://registry.npmjs.org"],
            )

    @patch("devtools.builtin_scripts.shutil.which", return_value="/usr/bin/mvn")
    @patch("devtools.builtin_scripts.subprocess.run")
    def test_run_maven_dependency_update_minor_uses_no_major_flag(self, run_mock: Mock, _which_mock: Mock) -> None:
        run_mock.return_value = Mock(returncode=0, stdout="", stderr="")
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            (root / "pom.xml").write_text("<project/>", encoding="utf-8")
            (root / "module-a").mkdir()
            (root / "module-a" / "pom.xml").write_text("<project/>", encoding="utf-8")

            context = _build_context(root, project_type="maven", script_id="maven_dependency_update_minor", default_args={"allow_major_updates": False})
            result = run_maven_dependency_update(context)

            self.assertTrue(result["success"])
            self.assertEqual(run_mock.call_count, 2)
            command = run_mock.call_args_list[0].args[0]
            self.assertEqual(
                command,
                [
                    "/usr/bin/mvn",
                    "versions:use-latest-releases",
                    "-DgenerateBackupPoms=false",
                    "-DallowMajorUpdates=false",
                    "-f",
                    "pom.xml",
                ],
            )

    @patch("devtools.builtin_scripts.shutil.which", return_value="/usr/bin/mvn")
    @patch("devtools.builtin_scripts.subprocess.run")
    def test_run_maven_dependency_update_major_omits_no_major_flag(self, run_mock: Mock, _which_mock: Mock) -> None:
        run_mock.return_value = Mock(returncode=0, stdout="", stderr="")
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            (root / "pom.xml").write_text("<project/>", encoding="utf-8")

            context = _build_context(root, project_type="maven", script_id="maven_dependency_update_major", default_args={"allow_major_updates": True})
            result = run_maven_dependency_update(context)

            self.assertTrue(result["success"])
            command = run_mock.call_args.args[0]
            self.assertEqual(
                command,
                [
                    "/usr/bin/mvn",
                    "versions:use-latest-releases",
                    "-DgenerateBackupPoms=false",
                    "-f",
                    "pom.xml",
                ],
            )


def _build_context(
    project_root: Path,
    project_type: str,
    script_id: str,
    default_args: dict[str, object],
) -> ScriptContext:
    project = Project(
        name=project_root.name,
        path=project_root,
        project_type=project_type,
        marker="package.json" if project_type == "node" else "pom.xml",
    )
    script = ScriptDefinition(
        script_id=script_id,
        name=script_id,
        description="desc",
        project_types=[project_type],
        entry="runner.py:main",
        directory=project_root,
        manifest_path=project_root / "manifest.toml",
        default_args=default_args,
    )
    return ScriptContext(
        config_path=project_root / "devtools.toml",
        script=script,
        project=project,
        args=dict(script.default_args),
        run_id="test-run",
    )
