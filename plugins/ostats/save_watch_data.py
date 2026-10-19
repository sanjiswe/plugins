"""Reads and writes O Stats' watch time file (watch_data.json).

Run by the O Stats page through Stash's runPluginOperation with an "args"
map. Modes:
  add   - add {seconds} to {day} (YYYY-MM-DD) and return the day's new total
  save  - replace all watch time with {watch_data} (a JSON string, used by
          Import)
  load  - return all watch time

The file maps each day to its watch time in seconds: {"2026-10-18": 1219}.
Writes take a lock file and replace the file in one step, so saves from
several tabs or devices never overwrite each other or leave a half-written
file behind.
"""

import json
import os
import re
import sys
import time

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(PLUGIN_DIR, 'watch_data.json')
LOCK_FILE = DATA_FILE + '.lock'
DAY_PATTERN = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def to_seconds(value):
    """Watch time for one day from any format O Stats has used: a number,
    {"totalTime": n} (very old files), {"seconds": n, "o_count": n} (export
    3.0) or "seconds,oCount" (export 2.0)."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, dict):
        return to_seconds(value.get('seconds', value.get('totalTime', 0)))
    if isinstance(value, str):
        try:
            return float(value.split(',')[0])
        except ValueError:
            return 0
    return 0


def normalize(watch_data):
    """Plain {day: seconds}, unwrapping an export file if given one."""
    if isinstance(watch_data, dict) and isinstance(watch_data.get('data'), dict):
        watch_data = watch_data['data']
    if not isinstance(watch_data, dict):
        return {}
    result = {}
    for day, value in watch_data.items():
        if DAY_PATTERN.match(str(day)):
            seconds = to_seconds(value)
            result[day] = int(seconds) if float(seconds).is_integer() else seconds
    return result


def read_data():
    if not os.path.exists(DATA_FILE):
        return {}
    with open(DATA_FILE, 'r', encoding='utf-8') as f:
        return normalize(json.load(f))


def write_data(watch_data):
    """Write to a temporary file and swap it in, so the file is never left
    half-written."""
    temp_file = DATA_FILE + '.tmp'
    with open(temp_file, 'w', encoding='utf-8') as f:
        json.dump(dict(sorted(watch_data.items())), f, indent=2)
    os.replace(temp_file, DATA_FILE)


class FileLock:
    """Lock file so two saves running at once take turns. A lock left behind
    by a crashed run is cleared after 30 seconds."""

    def __enter__(self):
        deadline = time.time() + 10
        while True:
            try:
                fd = os.open(LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.close(fd)
                return self
            except FileExistsError:
                try:
                    if time.time() - os.path.getmtime(LOCK_FILE) > 30:
                        os.remove(LOCK_FILE)
                        continue
                except OSError:
                    continue
                if time.time() > deadline:
                    raise TimeoutError('Timed out waiting for the watch data lock')
                time.sleep(0.05)

    def __exit__(self, *exc):
        try:
            os.remove(LOCK_FILE)
        except OSError:
            pass


def main():
    input_data = json.loads(sys.stdin.read() or '{}')
    args = input_data.get('args') or {}
    mode = args.get('mode', 'load')

    try:
        if mode == 'add':
            day = str(args.get('day', ''))
            seconds = to_seconds(args.get('seconds', 0))
            if not DAY_PATTERN.match(day):
                raise ValueError(f'Invalid day: {day!r}')
            if seconds <= 0 or seconds > 86400:
                raise ValueError(f'Invalid seconds: {seconds!r}')
            with FileLock():
                watch_data = read_data()
                watch_data[day] = watch_data.get(day, 0) + int(seconds)
                write_data(watch_data)
            print(json.dumps({'output': watch_data[day]}))
        elif mode == 'save':
            raw = args.get('watch_data')
            if raw is None:
                raise ValueError('No watch data provided')
            watch_data = normalize(json.loads(raw) if isinstance(raw, str) else raw)
            with FileLock():
                write_data(watch_data)
            print(json.dumps({'output': len(watch_data)}))
        else:
            print(json.dumps({'output': read_data()}))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
