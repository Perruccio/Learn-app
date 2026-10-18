#!/usr/bin/env python3
"""Stamp a content-based version on every internal asset URL (cache busting).

GitHub Pages lets browsers cache files for ~10 minutes. Adding ``?v=<hash>`` to
every internal module/stylesheet URL makes a new deploy load fresh code, and
``version.json`` lets a running app detect that a newer version exists.

Run before every commit:  python scripts/stamp.py
"""
import hashlib
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
JS = sorted((ROOT / "js").glob("*.js"))
CSS = sorted((ROOT / "css").glob("*.css"))
INDEX = ROOT / "index.html"

VERSION_QS = re.compile(r"\?v=[0-9a-f]+")
APP_VERSION = re.compile(r"const APP_VERSION = '[^']*';")
IMPORT = re.compile(r"""(from\s+'\./[\w-]+\.js)(\?v=[0-9a-f]+)?(')""")
HTML_ASSET = re.compile(r"""((?:href|src)="(?:css|js)/[\w-]+\.(?:css|js))(\?v=[0-9a-f]+)?(")""")


def normalized(text: str) -> str:
    text = VERSION_QS.sub("", text)
    return APP_VERSION.sub("const APP_VERSION = '';", text)


def main() -> None:
    digest = hashlib.sha256()
    for path in [*JS, *CSS, INDEX]:
        digest.update(path.name.encode())
        digest.update(normalized(path.read_text(encoding="utf-8")).encode())
    version = digest.hexdigest()[:12]

    for path in JS:
        text = path.read_text(encoding="utf-8")
        text = IMPORT.sub(lambda m: f"{m.group(1)}?v={version}{m.group(3)}", text)
        text = APP_VERSION.sub(f"const APP_VERSION = '{version}';", text)
        path.write_text(text, encoding="utf-8")

    html = INDEX.read_text(encoding="utf-8")
    INDEX.write_text(HTML_ASSET.sub(lambda m: f"{m.group(1)}?v={version}{m.group(3)}", html), encoding="utf-8")
    (ROOT / "version.json").write_text(json.dumps({"version": version}) + "\n", encoding="utf-8")
    print(version)


if __name__ == "__main__":
    main()
