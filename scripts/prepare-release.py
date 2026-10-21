#!/usr/bin/env python3
"""Prepare pinned Rabby runtime comparisons with an internal test setup page."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile

SHA256 = 'e1132d749d4f34d3c7a870dfcfc07ecfef1b6030a1c386c28747e8e16417aa39'
parser = argparse.ArgumentParser()
parser.add_argument('--zip', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--variant', choices=['baseline', 'candidate'], required=True)
args = parser.parse_args()
assert hashlib.sha256(args.zip.read_bytes()).hexdigest() == SHA256, 'Unexpected release ZIP hash'
assert not args.output.exists(), 'Output must be a new directory'
with zipfile.ZipFile(args.zip) as archive:
    assert all(not PurePosixPath(n).is_absolute() and '..' not in PurePosixPath(n).parts for n in archive.namelist()), 'Unsafe ZIP path'
    archive.extractall(args.output)
manifests = list(args.output.rglob('manifest.json'))
assert len(manifests) == 1, 'Expected one extension manifest'
root = manifests[0].parent
background = root / 'background.js'
original = background.read_bytes()
if args.variant == 'candidate':
    old = b'query({url:"<all_urls>",windowType:"normal"})'
    new = b'query({url:"<all_urls>"})'
    assert original.count(old) == 1, 'Expected exactly one READY-query filter'
    background.write_bytes(original.replace(old, new, 1))
(root / 'reliability-probe.html').write_text('<!doctype html><html><head><meta charset="utf-8"><title>Local Rabby test setup</title></head><body>Isolated watch-only test setup.</body></html>\n')
metadata = {
    'release': 'v0.94.12', 'zipSha256': SHA256, 'variant': args.variant,
    'method': 'Official release plus static internal setup page; candidate removes one query filter in background.js. This is a controlled bundle comparison, not a full source build.',
    'backgroundOriginalSha256': hashlib.sha256(original).hexdigest(),
    'backgroundTestedSha256': hashlib.sha256(background.read_bytes()).hexdigest(),
    'files': {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file()},
}
args.output.with_suffix('.manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
print(root)
