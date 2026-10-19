import json
import sys
import os


def is_valid(state):
    return (
        isinstance(state, dict)
        and isinstance(state.get('baseline'), dict)
        and isinstance(state.get('startedAt'), str)
    )


def merge_states(existing, incoming):
    """Combine what is on disk with what a browser tab sends.

    A newer startedAt means the achievements were reset, so the incoming state
    replaces the old one. An older startedAt comes from a tab that missed a
    reset and is ignored. The same startedAt keeps the saved baseline, adds
    any stats the saved baseline is missing, and keeps every unlock with its
    earliest date.
    """
    if not is_valid(existing):
        return incoming
    if incoming['startedAt'] > existing['startedAt']:
        return incoming
    if incoming['startedAt'] < existing['startedAt']:
        return existing

    merged = dict(existing)
    baseline = dict(incoming.get('baseline') or {})
    baseline.update(existing.get('baseline') or {})
    merged['baseline'] = baseline

    unlocked = dict(existing.get('unlocked') or {})
    for key, date in (incoming.get('unlocked') or {}).items():
        if key not in unlocked or date < unlocked[key]:
            unlocked[key] = date
    merged['unlocked'] = unlocked
    return merged


def read_state(json_file):
    if not os.path.exists(json_file):
        return None
    with open(json_file, 'r', encoding='utf-8') as f:
        return json.load(f)


def main():
    plugin_dir = os.path.dirname(os.path.abspath(__file__))
    json_file = os.path.join(plugin_dir, 'cheevs_data.json')

    # Read input from stdin (passed from the UI). The page reads the file
    # straight from the plugin's assets, so saving is all this does.
    input_data = json.loads(sys.stdin.read())
    args = input_data.get('args', {})

    try:
        state_str = args.get('cheevs_data')
        if not state_str:
            print(json.dumps({"error": "No achievement data provided"}),
                  file=sys.stderr)
            sys.exit(1)

        incoming = json.loads(state_str)
        if not is_valid(incoming):
            print(json.dumps({"error": "Invalid achievement data"}),
                  file=sys.stderr)
            sys.exit(1)

        try:
            existing = read_state(json_file)
        except Exception:
            existing = None

        state = merge_states(existing, incoming)

        # Write to a temp file first so a crash never leaves a half-written file
        tmp_file = json_file + '.tmp'
        with open(tmp_file, 'w', encoding='utf-8') as f:
            json.dump(state, f, indent=2)
        os.replace(tmp_file, json_file)

        print(json.dumps({"output": "success"}))

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
