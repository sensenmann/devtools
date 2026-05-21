from __future__ import annotations


def main(context):
    limit = int(context.args.get("limit", 20))
    children = sorted(context.project.path.iterdir(), key=lambda item: item.name.lower())
    for child in children[:limit]:
        print(child.name)
    return {"success": True, "message": f"Listed up to {limit} entries."}

