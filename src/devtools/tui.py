from __future__ import annotations

from textual import on
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Footer, Header, Input, RichLog, SelectionList, Static

from devtools.service import DevtoolsService


class InfoScreen(ModalScreen[None]):
    def __init__(self, message: str) -> None:
        super().__init__()
        self.message = message

    def compose(self) -> ComposeResult:
        yield Vertical(
            Static(self.message, classes="dialog-message"),
            Button("Close", id="close-dialog"),
            classes="dialog",
        )

    @on(Button.Pressed, "#close-dialog")
    def close_dialog(self) -> None:
        self.dismiss(None)


class DevtoolsApp(App[None]):
    CSS = """
    Screen {
        layout: vertical;
    }
    #body {
        height: 1fr;
    }
    .panel {
        width: 1fr;
        border: solid #666666;
        padding: 1;
    }
    #controls {
        height: auto;
        padding: 1;
    }
    #run-log {
        height: 12;
    }
    .dialog {
        width: 60;
        height: auto;
        border: solid #999999;
        padding: 1 2;
        background: $surface;
    }
    .dialog-message {
        margin-bottom: 1;
    }
    """

    BINDINGS = [("r", "run_selected", "Run"), ("d", "refresh_data", "Refresh")]

    def __init__(self, service: DevtoolsService) -> None:
        super().__init__()
        self.service = service
        self.projects = []
        self.scripts = []

    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        yield Horizontal(
            Vertical(
                Static("Filter projects"),
                Input(placeholder="Name or path filter", id="project-filter"),
                SelectionList(id="projects-list"),
                classes="panel",
            ),
            Vertical(
                Static("Available scripts"),
                SelectionList(id="scripts-list"),
                classes="panel",
            ),
            id="body",
        )
        yield Horizontal(
            Button("Refresh", id="refresh-button", variant="default"),
            Button("Run", id="run-button", variant="success"),
            id="controls",
        )
        yield RichLog(id="run-log", wrap=True, markup=True)
        yield Footer()

    def on_mount(self) -> None:
        self.action_refresh_data()

    def action_refresh_data(self) -> None:
        self.projects = self.service.refresh_projects()
        self._refresh_project_list(self.projects)
        self._refresh_script_list([])
        self.query_one("#run-log", RichLog).write("[cyan]Refreshed top-level project cache[/cyan]")

    @on(Button.Pressed, "#refresh-button")
    def handle_refresh(self) -> None:
        self.action_refresh_data()

    @on(Input.Changed, "#project-filter")
    def handle_project_filter(self, event: Input.Changed) -> None:
        text = event.value.strip().lower()
        filtered = [
            project
            for project in self.projects
            if not text
            or text in project.name.lower()
            or text in project.path.as_posix().lower()
        ]
        self._refresh_project_list(filtered)

    @on(SelectionList.SelectedChanged, "#projects-list")
    def handle_project_selection(self) -> None:
        selected_projects = self._selected_projects()
        self._refresh_script_list(selected_projects)

    @on(Button.Pressed, "#run-button")
    def handle_run_button(self) -> None:
        self.action_run_selected()

    def action_run_selected(self) -> None:
        selected_projects = self._selected_projects()
        if not selected_projects:
            self.push_screen(InfoScreen("Select at least one project."))
            return

        selected_script = self._selected_script()
        if selected_script is None:
            self.push_screen(InfoScreen("Select one script."))
            return

        log = self.query_one("#run-log", RichLog)
        log.write(f"[bold]Running {selected_script.script_id}[/bold]")
        results = self.service.run_script(
            script_id=selected_script.script_id,
            projects=selected_projects,
            event_callback=log.write,
        )
        failures = 0
        for result in results:
            color = "green" if result.success else "red"
            log.write(f"[{color}]{result.project.name}[/{color}] {result.project.path}")
            if result.message:
                log.write(result.message)
            if result.output.strip():
                log.write(result.output.rstrip())
            if result.error.strip():
                log.write(result.error.rstrip())
            if not result.success:
                failures += 1
        summary_color = "green" if failures == 0 else "yellow"
        log.write(f"[{summary_color}]Finished with {failures} failure(s)[/{summary_color}]")

    def _refresh_project_list(self, projects) -> None:
        widget = self.query_one("#projects-list", SelectionList)
        widget.clear_options()
        for project in projects:
            label = f"{project.name} [{','.join(project.project_types or [project.project_type])}] {project.path}"
            widget.add_option((label, project.identity, False))

    def _refresh_script_list(self, projects) -> None:
        widget = self.query_one("#scripts-list", SelectionList)
        widget.clear_options()
        self.scripts = self.service.list_scripts(projects=projects)
        for script in self.scripts:
            label = f"{script.name} [{','.join(script.project_types)}]"
            widget.add_option((label, script.script_id, False))

    def _selected_projects(self):
        widget = self.query_one("#projects-list", SelectionList)
        selected = set(widget.selected)
        return [project for project in self.projects if project.identity in selected]

    def _selected_script(self):
        widget = self.query_one("#scripts-list", SelectionList)
        selected = list(widget.selected)
        if not selected:
            return None
        return next((script for script in self.scripts if script.script_id == selected[0]), None)
