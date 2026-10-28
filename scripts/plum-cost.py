#!/usr/bin/env python3
"""Plum's meter: what Plum's model calls cost, from the app's main.log.

Reads every `[Plum] turn N: stop=... in=... cache_read=... cache_write=... out=... ctx=...
kind=chat|director|wake|night model=<id> detached=true|false` line (PlumService.runTurnInner; lines
from before 2026-10-18 carry no kind/model and are priced as Opus chat) and prints, per kind:
calls, turns, $ total, $/hour of wall time the kind was active, model calls per turn and the
context p50 / p90 / max. The $/hour is the number the Jaz brief asks for after a director run.

Usage:
  python scripts/plum-cost.py                 # today's lines from %APPDATA%/Electron/logs (dev app)
  python scripts/plum-cost.py --since 2026-10-17 --until 2026-10-18
  python scripts/plum-cost.py --logs "C:/Users/me/AppData/Roaming/sentient-sims-app/logs"
  python scripts/plum-cost.py --last 10m      # the last ten minutes of lines only

Prices per million tokens (Anthropic list, 2026-10; keep in step with
src/main/sentient-sims/services/plum/plumPricing.ts).
"""
import argparse
import collections
import datetime as dt
import glob
import os
import re
import statistics
import sys

PRICES = {
    'claude-opus-5-5': (4.0, 0.20, 5.0, 20.0),
    'claude-opus-5': (5.0, 0.50, 6.25, 25.0),
    'claude-sonnet-5-5': (2.0, 0.20, 2.5, 10.0),
    'claude-sonnet-5': (2.0, 0.20, 2.5, 10.0),
    'claude-haiku-5-5': (0.10, 0.01, 0.125, 0.50),
}
DEFAULT_MODEL = 'claude-opus-5-5'

TURN = re.compile(
    r'^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\.\d+\].*\[Plum\] turn (\d+): stop=(\S+) in=(\d+) '
    r'cache_read=(\d+) cache_write=(\d+) out=(\d+)(?: ctx=(\d+))?'
    r'(?: kind=(\S+))?(?: model=(\S+))?(?: detached=(\S+))?'
)


def price_of(model):
    key = (model or DEFAULT_MODEL).lower()
    if key in PRICES:
        return PRICES[key]
    for known, price in PRICES.items():
        if key.startswith(known):
            return price
    return PRICES[DEFAULT_MODEL]


def cost(model, i, r, w, o):
    pi, pr, pw, po = price_of(model)
    return (i * pi + r * pr + w * pw + o * po) / 1e6


def default_logs():
    appdata = os.environ.get('APPDATA') or os.path.expanduser('~')
    for name in ('Electron', 'sentient-sims-app'):
        folder = os.path.join(appdata, name, 'logs')
        if os.path.isdir(folder):
            return folder
    return os.path.join(appdata, 'Electron', 'logs')


def parse_last(text):
    match = re.fullmatch(r'(\d+)([smhd])', text.strip())
    if not match:
        raise argparse.ArgumentTypeError('--last takes e.g. 10m, 2h, 1d')
    seconds = int(match.group(1)) * {'s': 1, 'm': 60, 'h': 3600, 'd': 86400}[match.group(2)]
    return dt.timedelta(seconds=seconds)


def read_calls(folder, since, until):
    files = sorted(glob.glob(os.path.join(folder, 'main*.log')))
    calls = []
    for path in files:
        with open(path, encoding='utf-8', errors='replace') as handle:
            for line in handle:
                match = TURN.match(line)
                if not match:
                    continue
                day, clock, it, stop, i, r, w, o, ctx, kind, model, detached = match.groups()
                when = dt.datetime.strptime(f'{day} {clock}', '%Y-%m-%d %H:%M:%S')
                if when < since or when >= until:
                    continue
                calls.append(
                    dict(
                        at=when,
                        it=int(it),
                        stop=stop,
                        i=int(i),
                        r=int(r),
                        w=int(w),
                        o=int(o),
                        ctx=int(ctx or 0),
                        kind=kind or 'chat',
                        model=model or DEFAULT_MODEL,
                        detached=detached == 'true',
                    )
                )
    # The dev app appends to main.log and rotates copies: the same line can be read twice
    seen = set()
    unique = []
    for call in sorted(calls, key=lambda c: c['at']):
        key = (call['at'], call['it'], call['i'], call['r'], call['w'], call['o'])
        if key in seen:
            continue
        seen.add(key)
        call['cost'] = cost(call['model'], call['i'], call['r'], call['w'], call['o'])
        unique.append(call)
    return unique


def group_turns(calls):
    """A turn is a run of iterations starting at `turn 1`, all of one kind."""
    turns = []
    for call in calls:
        if call['it'] == 1 or not turns:
            turns.append([call])
        else:
            turns[-1].append(call)
    return turns


def percentile(values, share):
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, int(round(share * (len(ordered) - 1))))
    return ordered[index]


def active_hours(calls, gap=dt.timedelta(minutes=10)):
    """Wall time the kind was active: the spans between calls, a gap over 10 min not counted."""
    if len(calls) < 2:
        return 0.0
    total = dt.timedelta()
    for before, after in zip(calls, calls[1:]):
        span = after['at'] - before['at']
        if span <= gap:
            total += span
    return total.total_seconds() / 3600


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--logs', default=default_logs(), help='the app log folder (main*.log)')
    parser.add_argument('--since', help='YYYY-MM-DD (default: today)')
    parser.add_argument('--until', help='YYYY-MM-DD, exclusive (default: tomorrow)')
    parser.add_argument('--last', type=parse_last, help='only the last 10m / 2h / 1d of lines')
    args = parser.parse_args()

    today = dt.datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    since = dt.datetime.strptime(args.since, '%Y-%m-%d') if args.since else today
    until = dt.datetime.strptime(args.until, '%Y-%m-%d') if args.until else since + dt.timedelta(days=1)
    if args.last:
        since = dt.datetime.now() - args.last
        until = dt.datetime.now() + dt.timedelta(days=1)

    calls = read_calls(args.logs, since, until)
    if not calls:
        print(f'no [Plum] turn lines between {since} and {until} in {args.logs}')
        return 1

    print(f'{len(calls)} calls from {calls[0]["at"]} to {calls[-1]["at"]} ({args.logs})')
    print(f'models: {dict(collections.Counter(c["model"] for c in calls))}')
    print()
    header = f'{"kind":<9} {"calls":>5} {"turns":>5} {"calls/turn":>10} {"$":>7} {"$/hour":>7} {"ctx p50":>8} {"ctx p90":>8} {"ctx max":>8} {"detached":>8}'
    print(header)
    print('-' * len(header))
    for kind in ('chat', 'director', 'wake', 'night'):
        rows = [c for c in calls if c['kind'] == kind]
        if not rows:
            continue
        turns = group_turns(rows)
        dollars = sum(c['cost'] for c in rows)
        hours = active_hours(rows)
        rate = dollars / hours if hours > 0.05 else float('nan')
        ctxs = [c['ctx'] for c in rows if c['ctx']]
        detached = sum(1 for c in rows if c['detached'])
        print(
            f'{kind:<9} {len(rows):>5} {len(turns):>5} {len(rows) / len(turns):>10.1f} {dollars:>7.2f} '
            f'{rate:>7.2f} {percentile(ctxs, 0.5):>8} {percentile(ctxs, 0.9):>8} {max(ctxs) if ctxs else 0:>8} '
            f'{detached:>4}/{len(rows):<3}'
        )
    total = sum(c['cost'] for c in calls)
    hours = active_hours(calls)
    print('-' * len(header))
    print(f'{"all":<9} {len(calls):>5} {len(group_turns(calls)):>5} {"":>10} {total:>7.2f} {total / hours if hours > 0.05 else float("nan"):>7.2f}')
    print()
    print('$/hour is spend over the wall time the kind was active (gaps over 10 min between calls do not count).')

    director = [c for c in calls if c['kind'] in ('director', 'wake')]
    if director:
        turns = group_turns(director)
        costs = sorted(sum(c['cost'] for c in t) for t in turns)
        print(
            f'director+wake turns: {len(turns)}  $ per turn mean {statistics.mean(costs):.3f} '
            f'p50 {percentile(costs, 0.5):.3f} p90 {percentile(costs, 0.9):.3f} max {costs[-1]:.3f}'
        )
        rolls = [c for c in director if c['it'] == 1 and c['r'] < 8000 and c['w'] > 8000]
        if rolls:
            print(f'cold-cache director calls (thread re-bought): {len(rolls)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
