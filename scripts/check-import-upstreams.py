#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import DefaultDict

LINE_RE = re.compile(
    r"^- `(?P<label>[^`]+)` → `(?P<url>https?://[^`]+)` @ `(?P<commit>[0-9a-f]{7,40})` \(`(?P<branch>origin/[^`]+)`\)$"
)


@dataclass
class SourceGroup:
    url: str
    branch: str
    pins_to_labels: DefaultDict[str, list[str]] = field(default_factory=lambda: defaultdict(list))


@dataclass
class CheckResult:
    url: str
    branch: str
    status: str
    pinned: str | None
    head: str | None
    labels: list[str]
    message: str | None = None


def default_agents_path() -> Path:
    return Path(__file__).resolve().parents[1] / "AGENTS.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compare imported-source pins in AGENTS.md against upstream branch heads."
    )
    parser.add_argument(
        "agents_path",
        nargs="?",
        default=str(default_agents_path()),
        help="Path to AGENTS.md (default: repo root AGENTS.md)",
    )
    return parser.parse_args()


def parse_source_groups(agents_path: Path) -> list[SourceGroup]:
    text = agents_path.read_text(encoding="utf-8")
    groups: dict[tuple[str, str], SourceGroup] = {}

    for line in text.splitlines():
        match = LINE_RE.match(line.strip())
        if not match:
            continue

        label = match.group("label")
        url = match.group("url")
        commit = match.group("commit")
        branch = match.group("branch").removeprefix("origin/")

        key = (url, branch)
        group = groups.get(key)
        if group is None:
            group = SourceGroup(url=url, branch=branch)
            groups[key] = group
        group.pins_to_labels[commit].append(label)

    return sorted(groups.values(), key=lambda g: (g.url, g.branch))


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


def check_group(group: SourceGroup) -> CheckResult:
    pins = sorted(group.pins_to_labels)
    labels = sorted(label for labels in group.pins_to_labels.values() for label in labels)
    head, error = ls_remote_head(group.url, group.branch)

    if error is not None:
        return CheckResult(
            url=group.url,
            branch=group.branch,
            status="error",
            pinned=pins[0] if len(pins) == 1 else None,
            head=None,
            labels=labels,
            message=error,
        )

    if len(pins) > 1:
        short_pins = ", ".join(pin[:12] for pin in pins)
        return CheckResult(
            url=group.url,
            branch=group.branch,
            status="inconsistent_pins",
            pinned=None,
            head=head,
            labels=labels,
            message=f"multiple pinned commits for same source: {short_pins}",
        )

    pinned = pins[0]
    assert head is not None
    head_str = head
    status = "up_to_date" if head_str.startswith(pinned) else "behind"
    message = None if status == "up_to_date" else "upstream head differs from pinned commit"
    return CheckResult(
        url=group.url,
        branch=group.branch,
        status=status,
        pinned=pinned,
        head=head_str,
        labels=labels,
        message=message,
    )


def print_result(result: CheckResult) -> None:
    print(f"[{result.status}] {result.url} @ {result.branch}")
    print(f"  pinned: {result.pinned or '-'}")
    print(f"  head:   {result.head or '-'}")
    if result.message:
        print(f"  note:   {result.message}")
    print("  labels:")
    for label in result.labels:
        print(f"    - {label}")
    print()


def main() -> int:
    args = parse_args()
    agents_path = Path(args.agents_path).expanduser().resolve()

    if not agents_path.exists():
        print(f"error: AGENTS file not found: {agents_path}", file=sys.stderr)
        return 2

    groups = parse_source_groups(agents_path)
    if not groups:
        print(f"error: no pinned upstream entries found in {agents_path}", file=sys.stderr)
        return 2

    print(f"AGENTS: {agents_path}")
    print(f"Tracked upstream sources: {len(groups)}")
    print()

    results = [check_group(group) for group in groups]
    for result in results:
        print_result(result)

    bad = [r for r in results if r.status != "up_to_date"]
    print(f"Summary: {len(results) - len(bad)} up_to_date, {len(bad)} non_green")
    return 0 if not bad else 1


if __name__ == "__main__":
    raise SystemExit(main())
