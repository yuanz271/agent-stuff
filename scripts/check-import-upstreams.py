#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

LINE_RE = re.compile(
    r"^- `(?P<label>[^`]+)` → `(?P<url>https?://[^`]+)` @ `(?P<commit>[0-9a-f]{7,40})` \(`(?P<branch>origin/[^`]+)`\)$"
)


@dataclass
class SourceEntry:
    label: str
    url: str
    branch: str
    pinned: str


@dataclass
class CheckResult:
    label: str
    url: str
    branch: str
    status: str
    pinned: str
    head: str | None
    message: str | None = None


def default_upstreams_path() -> Path:
    return Path(__file__).resolve().parents[1] / "UPSTREAMS.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare imported-source pins in UPSTREAMS.md against upstream branch heads and rewrite the per-skill/per-extension ledger to the latest checked heads."
    )
    parser.add_argument(
        "upstreams_path",
        nargs="?",
        default=str(default_upstreams_path()),
        help="Path to UPSTREAMS.md (default: repo root UPSTREAMS.md)",
    )
    return parser.parse_args()


def parse_entries(upstreams_path: Path) -> list[SourceEntry]:
    text = upstreams_path.read_text(encoding="utf-8")
    entries: list[SourceEntry] = []

    for line in text.splitlines():
        match = LINE_RE.match(line.strip())
        if not match:
            continue

        entries.append(
            SourceEntry(
                label=match.group("label"),
                url=match.group("url"),
                branch=match.group("branch").removeprefix("origin/"),
                pinned=match.group("commit"),
            )
        )

    return entries


def ls_remote_head(url: str, branch: str) -> tuple[str | None, str | None]:
    ref = f"refs/heads/{branch}"
    proc = subprocess.run(
        ["git", "ls-remote", url, ref],
        capture_output=True,
        text=True,
        check=False,
    )

    if proc.returncode != 0:
        err = proc.stderr.strip() or proc.stdout.strip() or f"git ls-remote failed with exit code {proc.returncode}"
        return None, err

    lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    if not lines:
        return None, f"branch not found: {branch}"

    head = lines[0].split()[0]
    if not re.fullmatch(r"[0-9a-f]{40}", head):
        return None, f"unexpected ls-remote output: {lines[0]}"
    return head, None


def check_entry(entry: SourceEntry) -> CheckResult:
    head, error = ls_remote_head(entry.url, entry.branch)

    if error is not None:
        return CheckResult(
            label=entry.label,
            url=entry.url,
            branch=entry.branch,
            status="error",
            pinned=entry.pinned,
            head=None,
            message=error,
        )

    assert head is not None
    status = "up_to_date" if head.startswith(entry.pinned) else "behind"
    message = None if status == "up_to_date" else "upstream head differs from pinned commit"
    return CheckResult(
        label=entry.label,
        url=entry.url,
        branch=entry.branch,
        status=status,
        pinned=entry.pinned,
        head=head,
        message=message,
    )


def print_result(result: CheckResult) -> None:
    print(f"[{result.status}] {result.url} @ {result.branch}")
    print(f"  label:  {result.label}")
    print(f"  pinned: {result.pinned}")
    print(f"  head:   {result.head or '-'}")
    if result.message:
        print(f"  note:   {result.message}")
    print()


def render_upstreams(entries: list[SourceEntry], results: list[CheckResult]) -> str:
    lines = [
        "# Upstream Pins",
        "",
        "This file records the last checked upstream commit for each imported skill or extension.",
        "Run `scripts/check-import-upstreams.py` to refresh it after checking upstreams.",
        "",
    ]

    for entry, result in zip(entries, results):
        commit = result.head or result.pinned
        lines.append(f"- `{entry.label}` → `{entry.url}` @ `{commit}` (`origin/{entry.branch}`)")

    lines.append("")
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    upstreams_path = Path(args.upstreams_path).expanduser().resolve()

    if not upstreams_path.exists():
        print(f"error: UPSTREAMS file not found: {upstreams_path}", file=sys.stderr)
        return 2

    entries = parse_entries(upstreams_path)
    if not entries:
        print(f"error: no pinned upstream entries found in {upstreams_path}", file=sys.stderr)
        return 2

    print(f"UPSTREAMS: {upstreams_path}")
    print(f"Tracked upstream entries: {len(entries)}")
    print()

    results = [check_entry(entry) for entry in entries]
    for result in results:
        print_result(result)

    upstreams_path.write_text(render_upstreams(entries, results), encoding="utf-8")

    bad = [r for r in results if r.status != "up_to_date"]
    print(f"Summary: {len(results) - len(bad)} up_to_date, {len(bad)} non_green")
    return 0 if not bad else 1


if __name__ == "__main__":
    raise SystemExit(main())
