"""Representative Python module for the file-skeleton profile fixtures.

Synthetic: this repository has no Python source, so this stands in for one.
"""

import json
import os
from dataclasses import dataclass


@dataclass
class LedgerEntry:
    """One assistant turn's token tallies."""

    session_id: str
    turn: int
    input_tokens: int
    output_tokens: int

    def total(self) -> int:
        """Sum of all token classes for this entry."""
        return self.input_tokens + self.output_tokens


class Ledger:
    """Accumulates entries and produces session totals."""

    def __init__(self, session_id: str) -> None:
        self.session_id = session_id
        self.entries: list[LedgerEntry] = []

    def add(self, entry: LedgerEntry) -> None:
        if entry.session_id != self.session_id:
            raise ValueError("session mismatch")
        self.entries.append(entry)

    def totals(self) -> dict[str, int]:
        """Aggregate token totals across all entries."""
        result = {"input": 0, "output": 0}
        for entry in self.entries:
            result["input"] += entry.input_tokens
            result["output"] += entry.output_tokens
        return result


def load_ledger(path: str) -> Ledger:
    """Read a ledger from a JSON file on disk."""
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    ledger = Ledger(data["session_id"])
    for row in data["entries"]:
        ledger.add(LedgerEntry(**row))
    return ledger


def write_ledger(ledger: Ledger, path: str) -> None:
    """Serialize a ledger, creating parent directories as needed."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = {
        "session_id": ledger.session_id,
        "entries": [entry.__dict__ for entry in ledger.entries],
        "totals": ledger.totals(),
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


class ReportRenderer:
    """Renders ledger totals as an aligned plain-text table."""

    def __init__(self, ledger: Ledger, currency: str = "USD") -> None:
        self.ledger = ledger
        self.currency = currency
        self._column_width = 14

    def render(self) -> str:
        """Build the full report string for terminal display."""
        totals = self.ledger.totals()
        lines = ["Redutok report", f"Session: {self.ledger.session_id}", ""]
        for name, value in totals.items():
            padded = name.ljust(self._column_width)
            lines.append(f"  {padded}{value:,}")
        lines.append("")
        lines.append(f"  {'total'.ljust(self._column_width)}{sum(totals.values()):,}")
        return "\n".join(lines)

    def render_row(self, entry: LedgerEntry) -> str:
        """Render one per-turn row with the turn number and both tallies."""
        return (
            f"turn {entry.turn:>4}  "
            f"in {entry.input_tokens:>8,}  "
            f"out {entry.output_tokens:>8,}"
        )


def merge_ledgers(ledgers: list[Ledger], session_id: str) -> Ledger:
    """Combine several ledgers into one, renumbering turns sequentially."""
    merged = Ledger(session_id)
    turn = 0
    for ledger in ledgers:
        for entry in ledger.entries:
            turn += 1
            merged.add(
                LedgerEntry(
                    session_id=session_id,
                    turn=turn,
                    input_tokens=entry.input_tokens,
                    output_tokens=entry.output_tokens,
                )
            )
    return merged


def diff_totals(before: Ledger, after: Ledger) -> dict[str, int]:
    """Per-class token deltas between two ledgers, positive means growth."""
    result = {}
    totals_before = before.totals()
    totals_after = after.totals()
    for key in totals_after:
        result[key] = totals_after[key] - totals_before.get(key, 0)
    return result
