"""Reads and writes No Nut November's own data file (nnndata.json).

Only used when O Stats isn't installed; with O Stats, its data file is read
instead. The file has the same layout as O Stats' odata.json, so the two
can be read the same way (and merged, if both have data).

Run by No Nut November through Stash's runPluginOperation with an "args"
map. Modes:
  add      - add {seconds} of watch time to {day} (YYYY-MM-DD) and return
             the day's new total. {playback} (a JSON list) saves playback
             stretches too; seconds can be 0 when there are only those
  image_o  - record an O on image {image_id}: {action} is "add" (with the
             O's {time}), "remove" (the latest O) or "reset" (all of them).
             Returns the image's number of saved O's
  load     - return all data

  {"watch_time": {"2026-11-03": 1219},
   "image_o_history": {"42": ["2026-11-03T21:04:11.000Z"]},
   "playback": [{"id": "lq3k9a", "scene": "123", "start": 1793743530,
                 "end": 1793744930, "seconds": 1380}]}

Writes take a lock file and replace the file in one step, so saves from
several tabs never overwrite each other or leave a half-written file.
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timezone

PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(PLUGIN_DIR, 'nnndata.json')
LOCK_FILE = DATA_FILE + '.lock'
DAY_PATTERN = re.compile(r'^\d{4}-\d{2}-\d{2}$')
STRETCH_ID_PATTERN = re.compile(r'^[A-Za-z0-9_-]{1,40}$')


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


def normalize_stretch(stretch):
    """One playback stretch, or None if it isn't a valid one."""
    if not isinstance(stretch, dict):
        return None
    stretch_id = str(stretch.get('id', ''))
    scene = str(stretch.get('scene', ''))
    try:
        start = int(stretch.get('start'))
        end = int(stretch.get('end'))
        seconds = int(round(float(stretch.get('seconds', 0))))
    except (TypeError, ValueError):
        return None
    if not STRETCH_ID_PATTERN.match(stretch_id) or not scene.isdigit():
        return None
    # At most a day long, and no more watched than the time it spans
    if start <= 0 or end < start or end - start > 86400:
        return None
    seconds = max(0, min(seconds, end - start + 60))
    return {
        'id': stretch_id,
        'scene': scene,
        'start': start,
        'end': end,
        'seconds': seconds,
    }


def normalize_playback(playback):
    """Valid stretches, oldest first, one per id (the last one wins)."""
    if not isinstance(playback, list):
        return []
    by_id = {}
    for stretch in map(normalize_stretch, playback):
        if stretch:
            by_id[stretch['id']] = stretch
    return sorted(by_id.values(), key=lambda s: (s['start'], s['id']))


def read_data():
    data = {'watch_time': {}, 'image_o_history': {}, 'playback': []}
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            watch_time = raw.get('watch_time')
            if isinstance(watch_time, dict):
                data['watch_time'] = {
                    day: seconds
                    for day, seconds in watch_time.items()
                    if DAY_PATTERN.match(str(day))
                    and isinstance(seconds, (int, float))
                    and not isinstance(seconds, bool)
                }
            images = raw.get('image_o_history')
            if isinstance(images, dict):
                data['image_o_history'] = {
                    str(image_id): sorted(t for t in map(parse_time, times) if t)
                    for image_id, times in images.items()
                    if str(image_id).isdigit() and isinstance(times, list)
                }
            data['playback'] = normalize_playback(raw.get('playback'))
    return data


# A stretch this old is finished: no tab will save it again
FINISHED_AFTER_SECONDS = 600
# Finished stretches of the same scene this close together are joined
JOIN_GAP_SECONDS = 60


def compact_playback(playback, now):
    """Joins finished stretches of the same scene that overlap or are under
    a minute apart, and drops finished ones with nothing watched, so reloads
    don't pile up stretches."""
    finished = [s for s in playback if s['end'] < now - FINISHED_AFTER_SECONDS]
    active = [s for s in playback if s['end'] >= now - FINISHED_AFTER_SECONDS]
    joined = []
    for stretch in sorted(finished, key=lambda s: (s['scene'], s['start'])):
        last = joined[-1] if joined else None
        if (
            last
            and last['scene'] == stretch['scene']
            and stretch['start'] <= last['end'] + JOIN_GAP_SECONDS
        ):
            last['end'] = max(last['end'], stretch['end'])
            last['seconds'] = min(
                last['seconds'] + stretch['seconds'],
                last['end'] - last['start'] + 60,
            )
        else:
            joined.append(dict(stretch))
    kept = [s for s in joined if s['seconds'] > 0] + active
    return sorted(kept, key=lambda s: (s['start'], s['id']))


def dump_data(data):
    """The file's text, with one playback stretch per line (there are many)."""
    images = data['image_o_history']
    text = json.dumps(
        {
            'watch_time': dict(sorted(data['watch_time'].items())),
            'image_o_history': {
                key: images[key] for key in sorted(images, key=int)
            },
        },
        indent=2,
    )
    stretches = ',\n'.join(
        '    ' + json.dumps(stretch) for stretch in data['playback']
    )
    playback = f'[\n{stretches}\n  ]' if stretches else '[]'
    # text ends with "\n}": add playback before the closing brace
    return f'{text[:-2]},\n  "playback": {playback}\n}}\n'


def write_data(data):
    """Write to a temporary file and swap it in, so the file is never left
    half-written."""
    temp_file = DATA_FILE + '.tmp'
    with open(temp_file, 'w', encoding='utf-8') as f:
        f.write(dump_data(data))
    # On Windows this fails while another program (an editor, antivirus,
    # or Stash serving the file) has it open, so it's retried for 2 seconds
    for attempt in range(40):
        try:
            os.replace(temp_file, DATA_FILE)
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
            seconds = args.get('seconds', 0)
            if not isinstance(seconds, (int, float)) or isinstance(seconds, bool):
                seconds = 0
            raw_playback = args.get('playback')
            if isinstance(raw_playback, str):
                raw_playback = json.loads(raw_playback)
            stretches = normalize_playback(raw_playback)
            if not DAY_PATTERN.match(day):
                raise ValueError(f'Invalid day: {day!r}')
            if seconds < 0 or seconds > 86400 or (seconds == 0 and not stretches):
                raise ValueError(f'Invalid seconds: {seconds!r}')
            with FileLock():
                data = read_data()
                watch_time = data['watch_time']
                if seconds > 0:
                    watch_time[day] = watch_time.get(day, 0) + int(seconds)
                if stretches:
                    data['playback'] = compact_playback(
                        normalize_playback(data['playback'] + stretches),
                        int(time.time()),
                    )
                write_data(data)
            print(json.dumps({'output': watch_time.get(day, 0)}))
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
                    # The browser's time; the server's if that's missing
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
        else:
            print(json.dumps({'output': read_data()}))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)


if __name__ == '__main__':
    main()
