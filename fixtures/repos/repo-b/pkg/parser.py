"""Tiny parser module for the codex fixture repo."""


def tokenize(text: str) -> list[str]:
    """Split text on whitespace, dropping empties."""
    return [t for t in text.split() if t]


class Counter:
    """Counts token frequencies."""

    def __init__(self) -> None:
        self.counts: dict[str, int] = {}

    def feed(self, tokens: list[str]) -> None:
        for token in tokens:
            self.counts[token] = self.counts.get(token, 0) + 1
