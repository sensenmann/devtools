from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from devtools.models import AppConfig, DiscoveryConfig, ScriptsConfig
from devtools.discovery import discover_explicit_projects, discover_projects, rebuild_project_cache


class DiscoveryTests(unittest.TestCase):
    def test_discover_projects_detects_multiple_types(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "java-app").mkdir()
            (root / "java-app" / "pom.xml").write_text("<project />", encoding="utf-8")
            (root / "web-app").mkdir()
            (root / "web-app" / "package.json").write_text("{}", encoding="utf-8")
            (root / "py-app").mkdir()
            (root / "py-app" / "pyproject.toml").write_text("[project]\nname='x'", encoding="utf-8")
            (root / "container").mkdir()
            (root / "container" / "nested").mkdir()
            (root / "container" / "nested" / "package.json").write_text("{}", encoding="utf-8")

            config = AppConfig(
                config_path=root / "devtools.toml",
                discovery=DiscoveryConfig(
                    roots=[root],
                    include_patterns=[],
                    exclude_patterns=[],
                    project_types=["maven", "node", "python"],
                    cache_file=root / ".cache.json",
                ),
                scripts=ScriptsConfig(directory=root / "scripts"),
            )

            projects = rebuild_project_cache(config)
            self.assertEqual([project.project_type for project in projects], ["node", "maven", "python", "node"])
            self.assertEqual({project.name for project in projects}, {"container", "java-app", "py-app", "web-app"})
            project_map = {project.name: project for project in projects}
            self.assertEqual(project_map["container"].project_types, ["node"])
            self.assertEqual(project_map["java-app"].project_types, ["maven"])
            self.assertEqual(project_map["web-app"].project_types, ["node"])
            self.assertTrue(config.discovery.cache_file.exists())

    def test_discover_explicit_projects_ignores_unknown_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "plain").mkdir()
            (root / "py-app").mkdir()
            (root / "py-app" / "pyproject.toml").write_text("[project]\nname='x'", encoding="utf-8")
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

            projects = discover_explicit_projects(config, [root / "plain", root / "py-app"])
            self.assertEqual(len(projects), 1)
            self.assertEqual(projects[0].project_type, "python")
            self.assertEqual(projects[0].project_types, ["python"])

    def test_discover_projects_uses_existing_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "py-app").mkdir()
            (root / "py-app" / "pyproject.toml").write_text("[project]\nname='x'", encoding="utf-8")
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

            rebuild_project_cache(config)
            (root / "py-app" / "pyproject.toml").unlink()
            projects = discover_projects(config, refresh=False)
            self.assertEqual(len(projects), 0)

    def test_discover_projects_detects_multiple_capabilities_in_single_top_level_project(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "mixed").mkdir()
            (root / "mixed" / "pom.xml").write_text("<project/>", encoding="utf-8")
            (root / "mixed" / "ui").mkdir()
            (root / "mixed" / "ui" / "package.json").write_text("{}", encoding="utf-8")
            config = AppConfig(
                config_path=root / "devtools.toml",
                discovery=DiscoveryConfig(
                    roots=[root],
                    include_patterns=[],
                    exclude_patterns=[],
                    project_types=["maven", "node", "python"],
                    cache_file=root / ".cache.json",
                ),
                scripts=ScriptsConfig(directory=root / "scripts"),
            )

            projects = rebuild_project_cache(config)
            self.assertEqual(len(projects), 1)
            self.assertEqual(projects[0].project_type, "maven")
            self.assertEqual(projects[0].project_types, ["maven", "node"])
