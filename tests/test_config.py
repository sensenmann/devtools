from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from devtools.config import load_config


class ConfigTests(unittest.TestCase):
    def test_load_config_resolves_relative_scripts_dir(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            config_path = root / "devtools.toml"
            config_path.write_text(
                """
[discovery]
roots = ["~/Develop", "./projects"]
project_types = ["maven", "node"]

[scripts]
directory = "scripts"
""".strip(),
                encoding="utf-8",
            )

            config = load_config(str(config_path))
            self.assertEqual(config.scripts.directory, (root / "scripts").resolve())
            self.assertEqual(config.discovery.project_types, ["maven", "node"])
            self.assertEqual(
                config.discovery.cache_file,
                (root / ".devtools-project-cache.json").resolve(),
            )
