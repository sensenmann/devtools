from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from devtools.cli import main


class CliTests(unittest.TestCase):
    def test_projects_command_lists_explicit_project(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            project = root / "app"
            project.mkdir()
            (project / "pyproject.toml").write_text("[project]\nname='app'", encoding="utf-8")
            scripts_dir = root / "scripts"
            scripts_dir.mkdir()
            config_path = root / "devtools.toml"
            config_path.write_text(
                f"""
[discovery]
roots = ["{root.as_posix()}"]
project_types = ["python"]

[scripts]
directory = "{scripts_dir.as_posix()}"
""".strip(),
                encoding="utf-8",
            )
            output = io.StringIO()
            with redirect_stdout(output):
                exit_code = main(
                    ["--config", str(config_path), "projects", "--path", str(project)]
                )
            self.assertEqual(exit_code, 0)
            self.assertIn("python", output.getvalue())

