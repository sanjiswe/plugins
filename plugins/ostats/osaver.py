"""Reads and writes O Stats' data file (odata.json).

Run by O Stats through Stash's runPluginOperation with an "args" map. Modes:
  add      - add {seconds} of watch time to {day} (YYYY-MM-DD) and return
             the day's new total
  image_o  - record an O on image {image_id}: {action} is "add" (with the
             O's {time}), "remove" (the latest O) or "reset" (all of them).
             Returns the image's number of saved O's
  save     - replace the data with {o_data} (a JSON string, used by Import).
             Files without image O's leave the saved image O's alone
  load     - return all data

The file holds watch time in seconds per day, and the time of every O on
each image (Stash only keeps a count for images):
  {"watch_time": {"2026-10-18": 1219},
   "image_o_history": {"42": ["2026-10-18T21:04:11.000Z"]}}

Older versions kept only the watch time, in watch_data.json. It is read
until the first save, then kept as watch_data.json.bak.

Writes take a lock file and replace the file in one step, so saves from
several tabs or devices never overwrite each other or leave a half-written
file behind.
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timezone

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(PLUGIN_DIR, 'odata.json')
LEGACY_FILE = os.path.join(PLUGIN_DIR, 'watch_data.json')
LOCK_FILE = DATA_FILE + '.lock'
DAY_PATTERN = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def to_seconds(value):
    """Watch time for one day from any format O Stats has used: a number,
    {"totalTime": n} (very old files), {"seconds": n, "o_count": n} (export
    3.0 and later) or "seconds,oCount" (export 2.0)."""
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


def normalize_watch_time(days):
    """Plain {day: seconds}."""
    if not isinstance(days, dict):
        return {}
    result = {}
    for day, value in days.items():
        if DAY_PATTERN.match(str(day)):
            seconds = to_seconds(value)
            result[day] = int(seconds) if float(seconds).is_integer() else seconds
    return result


def parse_time(value):
    """The O's time as an ISO string, or None if it isn't one."""
    if not isinstance(value, str):
        return None
    try:
        # Python before 3.11 doesn't read a trailing "Z"
        datetime.fromisoformat(value.replace('Z', '+00:00'))
        return value
    except ValueError:
        return None


def normalize_image_o_history(history):
    """Plain {image id: [ISO times, oldest first]}."""
    if not isinstance(history, dict):
        return {}
    result = {}
    for image_id, times in history.items():
        if not str(image_id).isdigit() or not isinstance(times, list):
            continue
        valid = sorted(t for t in map(parse_time, times) if t)
        if valid:
            result[str(image_id)] = valid
    return result


def parse_data(raw):
    """Watch time and image O's from the data file, an export or an older
    file. Image O's are None when the source has none at all."""
    if isinstance(raw, dict) and isinstance(raw.get('data'), dict):
        # An export: days under "data", image O's beside them (export 4.0)
        days = raw['data']
        images = raw.get('image_o_history')
    elif isinstance(raw, dict) and ('watch_time' in raw or 'image_o_history' in raw):
        days = raw.get('watch_time')
        images = raw.get('image_o_history')
    else:
        # watch_data.json or a very old backup: just the days
        days = raw
        images = None
    return (
        normalize_watch_time(days),
        None if images is None else normalize_image_o_history(images),
    )


def read_data():
    for path in (DATA_FILE, LEGACY_FILE):
        if os.path.exists(path):
            with open(path, 'r', encoding='utf-8') as f:
                watch_time, images = parse_data(json.load(f))
            return {'watch_time': watch_time, 'image_o_history': images or {}}
    return {'watch_time': {}, 'image_o_history': {}}


def write_data(data):
    """Write to a temporary file and swap it in, so the file is never left
    half-written. The old watch_data.json is kept as a backup after the
    first write."""
    temp_file = DATA_FILE + '.tmp'
    images = data['image_o_history']
    with open(temp_file, 'w', encoding='utf-8') as f:
        json.dump(
            {
                'watch_time': dict(sorted(data['watch_time'].items())),
                'image_o_history': {
                    key: images[key] for key in sorted(images, key=int)
                },
            },
            f,
            indent=2,
        )
    replace_file(temp_file, DATA_FILE)
    if os.path.exists(LEGACY_FILE):
        replace_file(LEGACY_FILE, LEGACY_FILE + '.bak')


def replace_file(source, target):
    """os.replace, retried for up to 2 seconds. On Windows it fails while
    another program (an editor, antivirus, or Stash serving the file to the
    stats page) has the target open."""
    for attempt in range(40):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if attempt == 39:
                raise
            time.sleep(0.05)


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
                    raise TimeoutError('Timed out waiting for the data file lock')
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
                data = read_data()
                watch_time = data['watch_time']
                watch_time[day] = watch_time.get(day, 0) + int(seconds)
                write_data(data)
            print(json.dumps({'output': watch_time[day]}))
        elif mode == 'image_o':
            image_id = str(args.get('image_id', ''))
            action = args.get('action')
            if not image_id.isdigit():
                raise ValueError(f'Invalid image id: {image_id!r}')
            if action not in ('add', 'remove', 'reset'):
                raise ValueError(f'Invalid action: {action!r}')
            with FileLock():
                data = read_data()
                history = data['image_o_history']
                times = history.get(image_id, [])
                if action == 'add':
                    # The browser's time; the server's if that's missing,
                    # written the same way: 2026-10-21T14:03:00.000Z
                    server_time = (
                        datetime.now(timezone.utc)
                        .isoformat(timespec='milliseconds')
                        .replace('+00:00', 'Z')
                    )
                    times = sorted(
                        times + [parse_time(args.get('time')) or server_time]
                    )
                elif action == 'remove':
                    times = times[:-1]
                else:
                    times = []
                if times:
                    history[image_id] = times
                else:
                    history.pop(image_id, None)
                write_data(data)
            print(json.dumps({'output': len(times)}))
        elif mode == 'save':
            # "watch_data" is what versions before 2.2 sent
            raw = args.get('o_data', args.get('watch_data'))
            if raw is None:
                raise ValueError('No data provided')
            watch_time, images = parse_data(
                json.loads(raw) if isinstance(raw, str) else raw
            )
            with FileLock():
                data = read_data()
                data['watch_time'] = watch_time
                if images is not None:
                    data['image_o_history'] = images
                write_data(data)
            print(
                json.dumps(
                    {
                        'output': {
                            'days': len(watch_time),
                            'image_os': sum(
                                len(t) for t in data['image_o_history'].values()
                            )
                            if images is not None
                            else None,
                        }
                    }
                )
            )
        else:
            print(json.dumps({'output': read_data()}))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
