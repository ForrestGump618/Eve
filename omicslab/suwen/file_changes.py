"""Verified file writes with scoped, hash-guarded restoration."""
import difflib
import hashlib


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def describe(path, before, after, created=False):
    old, new = before.splitlines(), after.splitlines()
    matcher = difflib.SequenceMatcher(None, old, new, autojunk=True)
    added = deleted = 0
    for tag, a, b, c, d in matcher.get_opcodes():
        if tag in {"insert", "replace"}:
            added += d-c
        if tag in {"delete", "replace"}:
            deleted += b-a
    lines = list(difflib.unified_diff(old, new, fromfile="before/"+path, tofile="after/"+path, lineterm=""))
    patch = "\n".join(lines)
    return {"path": path, "beforeSha256": digest(before), "afterSha256": digest(after),
            "added": added, "deleted": deleted, "created": created, "verified": True,
            "diff": patch[:20000], "diffTruncated": len(patch) > 20000}


async def restore(platform, scope, change_id):
    row = platform.store.get("file_change", change_id, scope)
    if not row or row.get("reverted"):
        raise ValueError("改动不存在或已撤销")
    if row.get("created"):
        raise ValueError("新增文件请在文件管理中检查后删除；不会自动删除文件")
    backend = await platform.backend(scope)
    current = await backend.read_text(row["path"], max_bytes=2_000_000)
    content = current.get("content", current.get("text", ""))
    if current.get("truncated") or digest(content) != row["afterSha256"]:
        raise ValueError("文件已有后续改动，请先查看，不能覆盖")
    await backend.write_text(row["path"], row["before"])
    confirmed = await backend.read_text(row["path"], max_bytes=2_000_000)
    if confirmed.get("content", confirmed.get("text")) != row["before"]:
        raise ValueError("撤销后的回读校验失败，状态未标记为已撤销")
    row["reverted"] = True
    platform.store.put("file_change", change_id, row, scope, expected=row["revision"])
    return {"verified": True, "path": row["path"], "sha256": row["beforeSha256"]}
