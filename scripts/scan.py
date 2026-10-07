#!/usr/bin/env python3
# Sums the cost and tokens of the Claude Code transcripts for the last 30 days.
# Usage: scan.py <projects dir> <cache file>. Prints one JSON object.

import datetime
import json
import os
import sys

DAYS = 30
CACHE_VERSION = 1

# --- Prices ---

# US dollars per million tokens: input, output, cache read.
# Cache writes are 1.25x input for 5 minutes and 2x input for 1 hour.
PRICES = [
    ("claude-fable-5-1", 10.0, 50.0, 0.25),
    ("claude-mythos-5-1", 10.0, 50.0, 0.25),
    ("claude-fable-5", 10.0, 50.0, 1.0),
    ("claude-mythos-5", 10.0, 50.0, 1.0),
    ("claude-opus-5-5", 4.0, 20.0, 0.20),
    ("claude-opus-5", 5.0, 25.0, 0.50),
    ("claude-opus-4", 5.0, 25.0, 0.50),
    ("claude-sonnet-5", 2.0, 10.0, 0.20),
    ("claude-sonnet-4", 3.0, 15.0, 0.30),
    ("claude-haiku-4", 1.0, 5.0, 0.10),
]


def price_of(model):
    for prefix, inp, out, read in PRICES:
        if model.startswith(prefix):
            return inp, out, read
    return None


def cost_of(model, usage):
    price = price_of(model)
    if price is None:
        return 0.0
    inp, out, read = price
    written = usage.get("cache_creation_input_tokens") or 0
    split = usage.get("cache_creation") or {}
    written_1h = split.get("ephemeral_1h_input_tokens") or 0
    written_5m = max(written - written_1h, 0)
    usd = (
        (usage.get("input_tokens") or 0) * inp
        + (usage.get("output_tokens") or 0) * out
        + (usage.get("cache_read_input_tokens") or 0) * read
        + written_5m * inp * 1.25
        + written_1h * inp * 2.0
    ) / 1e6
    # Fast mode bills at twice the standard rate.
    if usage.get("speed") == "fast":
        usd *= 2
    return usd


def tokens_of(usage):
    return sum(
        usage.get(k) or 0
        for k in (
            "input_tokens",
            "output_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
        )
    )


# --- One transcript ---


def scan_file(path):
    entries = []
    with open(path, "rb") as f:
        for raw in f:
            if b'"usage"' not in raw or b'"assistant"' not in raw:
                continue
            try:
                row = json.loads(raw)
            except ValueError:
                continue
            message = row.get("message")
            if not isinstance(message, dict):
                continue
            usage = message.get("usage")
            model = message.get("model") or ""
            stamp = row.get("timestamp")
            if not isinstance(usage, dict) or not stamp or model.startswith("<"):
                continue
            try:
                when = datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
            except ValueError:
                continue
            day = when.astimezone().date().isoformat()
            # A resumed session copies earlier rows, so the same response can be in several files.
            key = "%s:%s" % (message.get("id") or "", row.get("requestId") or "")
            entries.append(
                [key, day, model, round(cost_of(model, usage), 6), tokens_of(usage)]
            )
    return entries


# --- All transcripts ---


def main():
    root, cache_path = sys.argv[1], sys.argv[2]
    today = datetime.date.today()
    first = today - datetime.timedelta(days=DAYS - 1)
    since = datetime.datetime.combine(first, datetime.time()).timestamp()

    try:
        with open(cache_path) as f:
            cache = json.load(f)
        if cache.get("version") != CACHE_VERSION:
            cache = None
    except (OSError, ValueError):
        cache = None
    old = (cache or {}).get("files", {})
    files = {}

    for folder, _, names in os.walk(root):
        for name in names:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(folder, name)
            try:
                stat = os.stat(path)
            except OSError:
                continue
            if stat.st_mtime < since:
                continue
            known = old.get(path)
            if known and known["size"] == stat.st_size and known["mtime"] == stat.st_mtime:
                files[path] = known
                continue
            try:
                entries = scan_file(path)
            except OSError:
                continue
            files[path] = {"size": stat.st_size, "mtime": stat.st_mtime, "entries": entries}

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    temp = cache_path + ".tmp"
    with open(temp, "w") as f:
        json.dump({"version": CACHE_VERSION, "files": files}, f, separators=(",", ":"))
    os.replace(temp, cache_path)

    days = {}
    for offset in range(DAYS):
        day = (first + datetime.timedelta(days=offset)).isoformat()
        days[day] = {"date": day, "usd": 0.0, "tokens": 0, "models": {}}
    seen = set()
    for record in files.values():
        for key, day, model, usd, tokens in record["entries"]:
            if day not in days or key in seen:
                continue
            seen.add(key)
            bucket = days[day]
            bucket["usd"] += usd
            bucket["tokens"] += tokens
            bucket["models"][model] = bucket["models"].get(model, 0.0) + usd

    for bucket in days.values():
        bucket["usd"] = round(bucket["usd"], 2)
        bucket["models"] = {m: round(v, 2) for m, v in bucket["models"].items()}
    print(json.dumps({"today": today.isoformat(), "days": list(days.values())}))


if __name__ == "__main__":
    main()
