"""Journal watcher for workflow runs: prints one line per finished agent.

  python3 -u scripts/watch_results.py <transcriptDir>/journal.jsonl [--skip-existing]

Prints `FINISHED <label> (result|failed) score=<n>` once per agent as its row lands in the
workflow's journal (score only when the agent returned one). Run it under a background
monitor so each finished owner wakes the orchestrator; --skip-existing ignores rows already
in the journal when the watcher (re)starts, so re-arming it does not repeat old events.
Only complete lines are consumed, so a row being written while it is read is picked up on
the next poll instead of being lost.
"""
import json, os, sys, time

path = sys.argv[1]
skip = '--skip-existing' in sys.argv[2:]
labels, seen, pos, buf = {}, set(), 0, ''
while True:
    if os.path.exists(path):
        with open(path, 'rb') as f:
            f.seek(pos)
            chunk = f.read()
        pos += len(chunk)
        buf += chunk.decode('utf-8', 'replace')
        *lines, buf = buf.split('\n')          # keep a trailing partial line for the next poll
        for line in lines:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            if r.get('type') == 'started':
                labels[r.get('key')] = r.get('label', '')
            elif r.get('type') in ('result', 'failed') and r.get('key') not in seen:
                seen.add(r.get('key'))
                res = r.get('result')
                score = f" score={res['score']}" if isinstance(res, dict) and 'score' in res else ''
                if not skip:
                    print(f"FINISHED {labels.get(r.get('key'), '?')} ({r['type']}){score}", flush=True)
        skip = False
    time.sleep(15)
