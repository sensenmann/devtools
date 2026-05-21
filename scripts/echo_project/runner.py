from __future__ import annotations


def main(context):
    print(f"project={context.project.name}")
    print(f"path={context.project.path}")
    print(f"type={context.project.project_type}")
    if context.args.get("include_marker", True):
        print(f"marker={context.project.marker}")
    return {"success": True, "message": "Project info printed."}

