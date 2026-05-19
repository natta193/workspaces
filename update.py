#!/usr/bin/env python3
"""
update.py — bump version, re-sign, commit, push, and create a GitHub release.

Usage:
    python update.py              # bump patch + sign + commit + push + release
    python update.py --no-bump    # sign without changing version
    python update.py --no-push    # skip commit/push
    python update.py --no-release # skip GitHub release
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


# ── GitHub release ────────────────────────────────────────────────────────────

def create_github_release(version: str, xpi: Path):
    tag = version
    print(f"\nCreating GitHub release {tag}…")

    result = subprocess.run(
        [
            'gh', 'release', 'create', tag,
            str(xpi),
            '--title', tag,
            '--notes', f'Firefox Workspaces {tag}',
        ],
        cwd=ROOT,
    )

    if result.returncode != 0:
        print("GitHub release failed (is 'gh' authenticated? run: gh auth login)")
    else:
        print(f"Release {tag} created with {xpi.name}")


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Re-sign the Firefox extension.')
    parser.add_argument('--no-bump',    action='store_true', help='Skip version bump')
    parser.add_argument('--no-push',    action='store_true', help='Skip commit and push')
    parser.add_argument('--no-release', action='store_true', help='Skip GitHub release')
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
            '--timeout',       '900000',
        ],
        env={**os.environ},
    )

    if result.returncode != 0:
        print("\nSigning failed.")
        sys.exit(result.returncode)

    xpis = sorted(artifacts_dir.glob('*.xpi'), key=lambda p: p.stat().st_mtime)
    if not xpis:
        print("\nSigned successfully (XPI not found locally).")
        sys.exit(0)

    xpi = xpis[-1]
    print(f"\nSigned: {xpi.name}")
    print("Install via: about:addons → ⚙ → Install Add-on From File")

    # Git commit + push
    if not args.no_push:
        print("\nCommitting and pushing…")
        subprocess.run(['git', 'add', 'manifest.json'], cwd=ROOT, check=True)
        subprocess.run(
            ['git', 'commit', '-m', f'bump to {version}'],
            cwd=ROOT, check=True,
        )
        subprocess.run(['git', 'push', 'origin', 'main'], cwd=ROOT, check=True)
        print("Pushed.")

    # GitHub release
    if not args.no_release:
        create_github_release(version, xpi)


if __name__ == '__main__':
    main()
