#!/usr/bin/env python3
"""
update.py — bump version, re-sign, and optionally push to git.

Usage:
    python update.py              # bump patch version + sign
    python update.py --no-bump   # sign without changing version
    python update.py --push      # sign + commit + git push
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent


# ── .env loader (no external deps) ──────────────────────────────────────────

def load_env(path: Path) -> dict:
    if not path.exists():
        print(f"Error: {path} not found.")
        print("Copy .env.example to .env and fill in your AMO credentials.")
        sys.exit(1)
    env = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, _, val = line.partition('=')
        env[key.strip()] = val.strip().strip('"').strip("'")
    return env


# ── Version bump ─────────────────────────────────────────────────────────────

def bump_patch(manifest_path: Path) -> tuple[str, str]:
    manifest = json.loads(manifest_path.read_text())
    parts = manifest['version'].split('.')
    parts[-1] = str(int(parts[-1]) + 1)
    old = manifest['version']
    manifest['version'] = '.'.join(parts)
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    return old, manifest['version']


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Re-sign the Firefox extension.')
    parser.add_argument('--no-bump', action='store_true', help='Skip version bump')
    parser.add_argument('--push',    action='store_true', help='Commit and git push after signing')
    args = parser.parse_args()

    env = load_env(ROOT / '.env')
    api_key    = env.get('AMO_API_KEY')
    api_secret = env.get('AMO_API_SECRET')

    if not api_key or not api_secret:
        print("Error: AMO_API_KEY and AMO_API_SECRET must be set in .env")
        sys.exit(1)

    # Version
    manifest_path = ROOT / 'manifest.json'
    if args.no_bump:
        version = json.loads(manifest_path.read_text())['version']
        print(f"Version: {version} (unchanged)")
    else:
        old, version = bump_patch(manifest_path)
        print(f"Version: {old} → {version}")

    # Sign
    print("\nSigning extension via Mozilla AMO…")
    artifacts_dir = ROOT / 'web-ext-artifacts'
    artifacts_dir.mkdir(exist_ok=True)

    result = subprocess.run(
        [
            'web-ext', 'sign',
            '--api-key',       api_key,
            '--api-secret',    api_secret,
            '--channel',       'unlisted',
            '--source-dir',    str(ROOT),
            '--artifacts-dir', str(artifacts_dir),
            '--timeout',       '300000',
        ],
        env={**os.environ},
    )

    if result.returncode != 0:
        print("\nSigning failed.")
        sys.exit(result.returncode)

    xpis = list(artifacts_dir.glob('*.xpi'))
    print(f"\nSigned: {xpis[-1].name}" if xpis else "\nSigned successfully.")
    print("Install via: about:addons → ⚙ → Install Add-on From File")

    # Git commit + push
    if args.push:
        print("\nCommitting and pushing…")
        subprocess.run(['git', 'add', 'manifest.json'], cwd=ROOT, check=True)
        subprocess.run(
            ['git', 'commit', '-m', f'chore: bump version to {version}'],
            cwd=ROOT, check=True,
        )
        subprocess.run(['git', 'push'], cwd=ROOT, check=True)
        print("Pushed.")


if __name__ == '__main__':
    main()
