import { rowKindLabel, type CompareReport, type ReportRow } from "./pom.ts";

export function renderReportPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Maven Dependency Compare</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet" />
    <style>
      body { color: #1f2937; }
      th { background: #f8fafc !important; position: sticky; top: 0; z-index: 1; }
      th.dep-col, td.dep-col { width: 280px; white-space: nowrap; }
      th.kind-col, td.kind-col { width: 110px; }
      th.action-col, td.action-col { width: 190px; }
      td.cell-highest { background: #ecfdf5 !important; }
      td.cell-outdated, td.cell-pinned { background: #fef2f2 !important; }
      .version { font-weight: 700; }
      .version-link, .dependency-link { color: inherit; text-decoration: none; }
      .version-link:hover, .version-link:focus, .dependency-link:hover, .dependency-link:focus { color: inherit; text-decoration: underline; }
      .muted { color: #94a3b8; }
      .badge { display: inline-block; border-radius: 999px; padding: 2px 7px; font-size: 12px; font-weight: 700; margin-left: 6px; }
      .badge-prop { background: #fef3c7; color: #92400e; }
      .badge-pin { background: #fee2e2; color: #991b1b; }
      .badge-provider { background: #fef3c7; color: #92400e; }
      .badge-warn { background: #fef3c7; color: #92400e; }
      .badge-update { background: #dbeafe; color: #1d4ed8; }
      .kind { display: inline-block; border-radius: 6px; padding: 2px 8px; background: #e2e8f0; color: #334155; font-size: 12px; font-weight: 700; }
      .kind-help { color: #64748b; font-size: .9rem; }
      .cell-actions, .row-actions { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; }
      .btn-xs { --bs-btn-padding-y: .2rem; --bs-btn-padding-x: .45rem; --bs-btn-font-size: .75rem; }
      .table-responsive { max-height: calc(100vh - 170px); }
      .tree { margin-top: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.88rem; line-height: 1.45; }
      .tree-line { white-space: pre; }
      .tree-branch { color: #94a3b8; }
      .tree-package { color: #0f172a; }
      .tree-version { color: #2563eb; }
      .tree-target .tree-package, .tree-target .tree-version { color: #b91c1c; }
      .table td, .table th { vertical-align: top; }
      .version-implicit { color: #94a3b8; }
      .not-used { color: #cbd5e1; font-style: italic; }
      .version-unresolved { color: #cbd5e1; font-style: italic; }
      .project-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .remove-project-btn { border: 0; background: transparent; color: #94a3b8; font-size: 14px; line-height: 1; padding: 0; }
      .remove-project-btn:hover { color: #475569; }
    </style>
  </head>
  <body class="bg-body-tertiary">
    <div class="container-fluid py-4">
      <div class="d-flex flex-wrap justify-content-between align-items-end gap-3 mb-3">
        <div>
          <h1 class="h3 mb-1">Maven Dependency Compare</h1>
          <p class="text-secondary mb-0" id="meta">Loading…</p>
        </div>
        <div class="d-flex flex-column align-items-start gap-2">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" id="showOnlyDifferences" />
            <label class="form-check-label" for="showOnlyDifferences">Show only differences</label>
          </div>
          <div class="form-check">
            <input class="form-check-input" type="checkbox" id="hideVersionUpdates" />
            <label class="form-check-label" for="hideVersionUpdates">Hide Version Updates</label>
          </div>
        </div>
      </div>
      <p class="kind-help mb-3">
        <strong>Parent</strong> = Version des Parent-POMs.
        <strong>Override</strong> = lokale Property, die parent-/BOM-gebündelte Versionen effektiv überschreibt.
        <strong>Managed</strong> = Version ist in <code>&lt;dependencyManagement&gt;</code> vorgegeben, wird aber erst bei echter Verwendung wirksam.
        <strong>Direct</strong> = tatsächlich verwendete direkte Dependency aus <code>&lt;dependencies&gt;</code>.
      </p>
      <div id="app"></div>
    </div>

    <div class="modal fade" id="statusModal" tabindex="-1" aria-hidden="true">
      <div class="modal-dialog modal-dialog-centered">
        <div class="modal-content">
          <div class="modal-header">
            <h2 class="modal-title fs-5" id="statusModalTitle">Working</h2>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <div class="d-flex align-items-center gap-3" id="statusModalLoading">
              <div class="spinner-border text-primary" role="status" aria-hidden="true"></div>
              <div id="statusModalMessage">Applying change…</div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary d-none" data-bs-dismiss="modal" id="statusModalContinue">Continue</button>
            <button type="button" class="btn btn-primary d-none" id="statusModalReload">Reload all Projects</button>
            <button type="button" class="btn btn-primary" data-bs-dismiss="modal" id="statusModalClose">Close</button>
          </div>
        </div>
      </div>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
    <script>
      let report = null;
      let statusModal = null;
      let hiddenProjects = new Set();

      async function fetchReport() {
        const response = await fetch('/api/report');
        report = await response.json();
        render();
      }

      async function postAction(path, payload) {
        showStatusModal('Applying change…', 'Working', true);
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const next = await response.json();
        if (!response.ok) {
          showStatusModal(next.error || 'Action failed.', 'Action failed', false, 'close');
          return;
        }
        report = next.report;
        render();
        if (next.partialUpdate) {
          showStatusModal('Done. The affected project columns were refreshed. Reload all projects for a full re-check, or continue with the partial update.', 'Done', false, 'reload');
          return;
        }
        showStatusModal('Done.', 'Done', false, 'close');
      }

      async function reloadAllProjects() {
        showStatusModal('Reloading all projects…', 'Working', true);
        const response = await fetch('/api/actions/reload-all', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
        const next = await response.json();
        if (!response.ok) {
          showStatusModal(next.error || 'Reload failed.', 'Reload failed', false, 'close');
          return;
        }
        report = next.report;
        render();
        showStatusModal('All projects reloaded.', 'Done', false, 'close');
      }

      function render() {
        const meta = document.getElementById('meta');
        meta.textContent = 'Generated at ' + report.generatedAt;
        const app = document.getElementById('app');
        const onlyDifferences = document.getElementById('showOnlyDifferences').checked;
        const hideVersionUpdates = document.getElementById('hideVersionUpdates').checked;
        const visibleReport = deriveVisibleReport(report, hiddenProjects);
        const head = visibleReport.projects.map((project) => (
          '<th><div class="project-head"><span>' + escapeHtml(project.name) + '</span><button class="remove-project-btn" title="Spalte entfernen" onclick="hideProject(' + escapeAttributeJson(project.path) + ')">×</button></div></th>'
        )).join('');
        const visibleRows = onlyDifferences
          ? visibleReport.rows.filter((row) => row.cells.some((cell) => cell.isOutdated || cell.isPinnedBelowProvider || cell.isMissingOverrideWarning))
          : visibleReport.rows;
        const rows = visibleRows.map(renderRow).join('');
        app.innerHTML = '<div class="table-responsive shadow-sm bg-white rounded border"><table class="table table-sm table-hover mb-0"><thead><tr><th class="dep-col">Dependency</th><th class="kind-col">Kind</th>' + head + '<th class="action-col">Actions</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      }

      function renderRow(row) {
        const cells = row.cells.map((cell) => {
          if (!cell.present) {
            if (cell.isMissingOverrideWarning) {
              return '<td><span class="badge badge-warn">property fehlt</span><div class="cell-actions"><button class="btn btn-outline-primary btn-xs" onclick="postAction(\\'/api/actions/adopt-highest\\', { rowId: \\'' + row.rowId + '\\', targetProjectPath: \\'' + cell.projectPath + '\\' })">Adopt property</button></div></td>';
            }
            return '<td><span class="not-used">nicht verwendet</span></td>';
          }
          const classes = [];
          if (cell.isPinnedBelowProvider) {
            classes.push('cell-pinned');
          } else if (cell.isHighest) {
            classes.push('cell-highest');
          } else if (cell.isOutdated) {
            classes.push('cell-outdated');
          }
          const badges = [
            cell.hasLocalPropertyOverride ? '<span class="badge badge-prop">property</span>' : '',
            cell.showAvailableUpdateVersion && !hideVersionUpdates && cell.availableUpdateVersion
              ? '<span class="badge badge-update">update ' + renderVersionLink(row, cell, cell.availableUpdateVersion) + '</span>'
              : '',
            cell.providerVersion && cell.hasDifferentProviderVersion
              ? '<span class="badge ' + (cell.isPinnedBelowProvider ? 'badge-pin' : 'badge-provider') + '">bundled ' + renderVersionLink(row, cell, cell.providerVersion) + '</span>'
              : ''
          ].join('');
          const tree = (cell.dependencyTrees || []).map(renderTree).join('');
          const buttonParts = [];
          if (cell.adoptHighestAvailable) {
            buttonParts.push('<button class="btn btn-outline-primary btn-xs" onclick="postAction(\\'/api/actions/adopt-highest\\', { rowId: \\'' + row.rowId + '\\', targetProjectPath: \\'' + cell.projectPath + '\\' })">Adopt highest</button>');
          }
          if (cell.removeOverrideAvailable) {
            buttonParts.push('<button class="btn btn-outline-secondary btn-xs" onclick="postAction(\\'/api/actions/remove-override\\', { rowId: \\'' + row.rowId + '\\', targetProjectPath: \\'' + cell.projectPath + '\\' })">Remove override</button>');
          }
          const buttons = buttonParts.length > 0 ? '<div class="cell-actions">' + buttonParts.join('') + '</div>' : '';
          const implicit = !cell.rawVersion && cell.displayVersion;
          const versionClass = implicit ? 'version version-implicit' : 'version';
          const versionTitle = implicit ? ' title="Version nicht explizit in pom.xml festgelegt"' : '';
          const versionMarkup = cell.displayVersion || cell.effectiveVersion || cell.rawVersion
            ? '<div class="' + versionClass + '"' + versionTitle + '>' + renderVersionLink(row, cell, cell.displayVersion || cell.effectiveVersion || cell.rawVersion || '') + badges + '</div>'
            : '<div class="version-unresolved" title="Version konnte nicht aufgelöst werden">unbekannt</div>';
          return '<td class="' + classes.join(' ') + '">' + versionMarkup + tree + buttons + '</td>';
        }).join('');
        const hasOutdatedTarget = row.cells.some((cell) => cell.adoptHighestAvailable);
        const hasRemovableOverride = row.cells.some((cell) => cell.removeOverrideAvailable);
        const missingPropertyTargets = row.kind === 'override'
          ? row.cells.filter((cell) => cell.isMissingOverrideWarning).map((cell) => cell.projectPath)
          : [];
        const rowActionParts = [];
        if (hasOutdatedTarget) {
          rowActionParts.push('<button class="btn btn-primary btn-xs" onclick="postAction(\\'/api/actions/adopt-highest\\', { rowId: \\'' + row.rowId + '\\', targetProjectPaths: ' + JSON.stringify(row.cells.filter((cell) => cell.adoptHighestAvailable).map((cell) => cell.projectPath)) + ' })">Adopt highest for all</button>');
        }
        if (missingPropertyTargets.length > 0) {
          rowActionParts.push('<button class="btn btn-primary btn-xs" onclick="postAction(\\'/api/actions/adopt-highest\\', { rowId: \\'' + row.rowId + '\\', targetProjectPaths: ' + JSON.stringify(missingPropertyTargets) + ' })">Adopt properties for all</button>');
        }
        if (hasRemovableOverride) {
          rowActionParts.push('<button class="btn btn-secondary btn-xs" onclick="postAction(\\'/api/actions/remove-override\\', { rowId: \\'' + row.rowId + '\\', targetProjectPaths: ' + JSON.stringify(row.cells.filter((cell) => cell.removeOverrideAvailable).map((cell) => cell.projectPath)) + ' })">Remove override for all</button>');
        }
        const rowActions = rowActionParts.length > 0 ? '<div class="row-actions">' + rowActionParts.join('') + '</div>' : '';
        return '<tr><td class="dep-col">' + renderDependencyLink(row) + '</td><td class="kind-col"><span class="kind">' + escapeHtml(row.kindLabel) + '</span></td>' + cells + '<td class="action-col">' + rowActions + '</td></tr>';
      }

      function deriveVisibleReport(sourceReport, hidden) {
        const visibleProjects = sourceReport.projects.filter((project) => !hidden.has(project.path));
        const visibleProjectPaths = new Set(visibleProjects.map((project) => project.path));
        const visibleRows = sourceReport.rows
          .map((row) => {
            const visibleCells = row.cells.filter((cell) => visibleProjectPaths.has(cell.projectPath));
            const highestVersion = getHighestVersion(visibleCells);
            const nextCells = visibleCells.map((cell) => {
              const effectiveVersion = cell.displayVersion || cell.effectiveVersion || cell.rawVersion;
              const isHighest = Boolean(cell.present && highestVersion && effectiveVersion && compareVersionsLite(effectiveVersion, highestVersion) === 0);
              const isOutdated = Boolean(cell.present && highestVersion && effectiveVersion && compareVersionsLite(effectiveVersion, highestVersion) < 0);
              return {
                ...cell,
                isHighest,
                isOutdated,
                isMissingOverrideWarning: Boolean(row.kind === 'override' && !cell.present),
                adoptHighestAvailable: Boolean(cell.present && highestVersion && effectiveVersion && compareVersionsLite(effectiveVersion, highestVersion) < 0),
                showAvailableUpdateVersion: Boolean(cell.present && row.availableUpdateVersion),
              };
            });
            return {
              ...row,
              highestVersion,
              cells: nextCells,
            };
          })
          .filter((row) => row.cells.some((cell) => cell.present));
        return {
          ...sourceReport,
          projects: visibleProjects,
          rows: visibleRows,
        };
      }

      function getHighestVersion(cells) {
        const versions = cells
          .filter((cell) => cell.present)
          .map((cell) => cell.displayVersion || cell.effectiveVersion || cell.rawVersion)
          .filter(Boolean);
        return versions.sort(compareVersionsLite).at(-1);
      }

      function compareVersionsLite(left, right) {
        const leftParts = String(left).split(/[^0-9A-Za-z]+/).filter(Boolean);
        const rightParts = String(right).split(/[^0-9A-Za-z]+/).filter(Boolean);
        const length = Math.max(leftParts.length, rightParts.length);
        for (let index = 0; index < length; index += 1) {
          const leftPart = leftParts[index] || '';
          const rightPart = rightParts[index] || '';
          const leftNumber = Number(leftPart);
          const rightNumber = Number(rightPart);
          const bothNumeric = Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftPart !== '' && rightPart !== '';
          const diff = bothNumeric ? leftNumber - rightNumber : leftPart.localeCompare(rightPart);
          if (diff !== 0) {
            return diff;
          }
        }
        return 0;
      }

      function hideProject(projectPath) {
        hiddenProjects.add(projectPath);
        render();
      }

      function renderTree(tree) {
        const lines = tree.split('\\n').filter(Boolean);
        const rendered = lines.map((line, index) => {
          const match = line.match(/^(\\s*(?:\\+\\- |\\\\- )?)(.+)$/);
          const prefix = match ? match[1] : '';
          const payload = match ? match[2] : line;
          const parts = payload.split(':');
          const css = index === lines.length - 1 ? 'tree-line tree-target' : 'tree-line';
          if (parts.length >= 3) {
            const version = parts.pop();
            const name = parts.join(':');
            return '<div class="' + css + '"><span class="tree-branch">' + escapeHtml(prefix) + '</span><span class="tree-package">' + escapeHtml(name) + '</span> <span class="tree-version">(' + escapeHtml(version || '') + ')</span></div>';
          }
          return '<div class="' + css + '"><span class="tree-branch">' + escapeHtml(prefix) + '</span><span class="tree-package">' + escapeHtml(payload) + '</span></div>';
        }).join('');
        return '<div class="tree">' + rendered + '</div>';
      }

      function renderVersionLink(row, cell, version) {
        if (row.kind === 'override' || !cell.groupId || !cell.artifactId || !version) {
          return escapeHtml(version || '');
        }
        const href = 'https://mvnrepository.com/artifact/' + encodeURIComponent(cell.groupId) + '/' + encodeURIComponent(cell.artifactId) + '/' + encodeURIComponent(version);
        return '<a class="version-link" href="' + href + '" target="_blank" rel="noreferrer noopener">' + escapeHtml(version) + '</a>';
      }

      function renderDependencyLink(row) {
        if (row.kind === 'override' || !row.cells.length) {
          return escapeHtml(row.label);
        }
        const sourceCell = row.cells.find((cell) => cell.groupId && cell.artifactId);
        if (!sourceCell || !sourceCell.groupId || !sourceCell.artifactId) {
          return escapeHtml(row.label);
        }
        const href = 'https://mvnrepository.com/artifact/' + encodeURIComponent(sourceCell.groupId) + '/' + encodeURIComponent(sourceCell.artifactId);
        return '<a class="dependency-link" href="' + href + '" target="_blank" rel="noreferrer noopener">' + escapeHtml(row.label) + '</a>';
      }

      function escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/\\"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function escapeAttributeJson(value) {
        return JSON.stringify(String(value)).replace(/"/g, '&quot;');
      }

      function showStatusModal(message, title, loading, mode) {
        document.getElementById('statusModalTitle').textContent = title;
        document.getElementById('statusModalMessage').textContent = message;
        document.getElementById('statusModalLoading').querySelector('.spinner-border').classList.toggle('d-none', !loading);
        document.getElementById('statusModalReload').classList.toggle('d-none', mode !== 'reload');
        document.getElementById('statusModalContinue').classList.toggle('d-none', mode !== 'reload');
        document.getElementById('statusModalClose').classList.toggle('d-none', loading);
        document.getElementById('statusModalClose').classList.toggle('d-none', mode === 'reload');
        if (!statusModal) {
          statusModal = new bootstrap.Modal(document.getElementById('statusModal'));
        }
        statusModal.show();
      }

      document.getElementById('showOnlyDifferences').addEventListener('change', () => render());
      document.getElementById('hideVersionUpdates').addEventListener('change', () => render());
      document.getElementById('statusModalReload').addEventListener('click', () => {
        void reloadAllProjects();
      });
      fetchReport().catch((error) => {
        showStatusModal(error instanceof Error ? error.message : String(error), 'Load failed', false, 'close');
      });
    </script>
  </body>
</html>`;
}

export function enrichReport(report: CompareReport): CompareReport & { rows: Array<ReportRow & { kindLabel: string }> } {
  return {
    ...report,
    rows: report.rows.map((row) => ({
      ...row,
      kindLabel: rowKindLabel(row.kind),
    })),
  };
}
