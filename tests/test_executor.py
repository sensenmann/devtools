from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from devtools.executor import run_script_for_project
from devtools.models import AppConfig, DiscoveryConfig, Project, ScriptDefinition, ScriptsConfig


class ExecutorTests(unittest.TestCase):
    def test_run_script_for_project_captures_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            script_dir = root / "scripts" / "demo"
            script_dir.mkdir(parents=True)
            script_file = script_dir / "runner.py"
            script_file.write_text(
                """
def main(context):
    print(f"hello {context.project.name}")
    return {"success": True, "message": "done"}
""".strip(),
                encoding="utf-8",
            )

            config = AppConfig(
                config_path=root / "devtools.toml",
                discovery=DiscoveryConfig(
                    roots=[root],
                    include_patterns=[],
                    exclude_patterns=[],
                    project_types=["python"],
                    cache_file=root / ".cache.json",
                ),
                scripts=ScriptsConfig(directory=root / "scripts"),
            )
            script = ScriptDefinition(
                script_id="demo",
                name="Demo",
                description="desc",
                project_types=["python"],
                entry="runner.py:main",
                directory=script_dir,
                manifest_path=script_dir / "manifest.toml",
            )
            project = Project(name="sample", path=root, project_type="python", marker="pyproject.toml")

            result = run_script_for_project(config, script, project)
            self.assertTrue(result.success)
            self.assertEqual(result.message, "done")
            self.assertIn("hello sample", result.output)
