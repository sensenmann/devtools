from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from devtools.models import AppConfig, DiscoveryConfig, Project, ScriptsConfig
from devtools.registry import applicable_scripts, load_scripts


class RegistryTests(unittest.TestCase):
    def test_load_scripts_and_filter_by_project_types(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            scripts_dir = root / "scripts"
            script_dir = scripts_dir / "node-only"
            script_dir.mkdir(parents=True)
            (script_dir / "manifest.toml").write_text(
                """
id = "node-only"
name = "Node Only"
description = "Node task"
project_types = ["node"]
entry = "runner.py:main"
""".strip(),
                encoding="utf-8",
            )

            config = AppConfig(
                config_path=root / "devtools.toml",
                discovery=DiscoveryConfig(
                    roots=[root],
                    include_patterns=[],
                    exclude_patterns=[],
                    project_types=["node"],
                    cache_file=root / ".cache.json",
                ),
                scripts=ScriptsConfig(directory=scripts_dir),
            )
            scripts = load_scripts(config)
            projects = [
                Project(name="demo", path=root, project_type="node", marker="package.json", project_types=["node"]),
            ]
            self.assertEqual(len(scripts), 1)
            self.assertEqual(len(applicable_scripts(scripts, projects)), 1)

    def test_applicable_scripts_accepts_mixed_capability_project(self) -> None:
        projects = [
            Project(
                name="mixed",
                path=Path("/tmp/mixed"),
                project_type="maven",
                marker="pom.xml",
                project_types=["maven", "node"],
            ),
        ]
        node_script = type("Script", (), {"project_types": ["node"]})()
        maven_script = type("Script", (), {"project_types": ["maven"]})()
        python_script = type("Script", (), {"project_types": ["python"]})()

        applicable = applicable_scripts([node_script, maven_script, python_script], projects)
        self.assertEqual(len(applicable), 2)
