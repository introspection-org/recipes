"""Entry point the Node adapter runs: one JSON request on stdin, one JSON result on stdout.

python -I docx_helper.py < request.json   ->   {"text": ..., "details": ...} or {"error": ...}
"""

import json
import sys
import time
from pathlib import Path

STARTED = time.perf_counter()

sys.path.insert(0, str(Path(__file__).resolve().parent))


def main() -> int:
    try:
        request = json.load(sys.stdin)
        import docx

        from recipe_documents_docx.ops import COMMANDS

        imported = time.perf_counter()
        opening = [0.0]
        original_open = docx.Document

        def timed_open(*args, **kwargs):
            began = time.perf_counter()
            try:
                return original_open(*args, **kwargs)
            finally:
                opening[0] += time.perf_counter() - began

        docx.Document = timed_open
        command = COMMANDS.get(request.get("command"))
        if command is None:
            raise ValueError(f"the Word adapter has no command {request.get('command')!r}")
        result = command(request)
        result.setdefault("details", {})["timing"] = {
            "import_ms": round((imported - STARTED) * 1000, 1),
            "open_ms": round(opening[0] * 1000, 1),
            "python_ms": round((time.perf_counter() - STARTED) * 1000, 1),
        }
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except ModuleNotFoundError as error:
        print(json.dumps({"error": f"This Recipe's Python has no {error.name}: the Word adapter needs paper-docx"}))
        return 1
    except Exception as error:  # the tool reports it as the call's error
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
