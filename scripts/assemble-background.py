#!/usr/bin/env python3
"""Assemble a disclosed Rabby source-background/released-UI comparison."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil


def digest(path):
    with path.open('rb') as stream:
        value = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
        return value.hexdigest()


def files_under(directory):
    result = {}
    for entry in sorted(directory.rglob('*')):
        if entry.is_symlink():
            raise ValueError(f'Symlink inputs are unsupported: {entry}')
        if entry.is_file():
            result[entry.relative_to(directory).as_posix()] = entry
        elif not entry.is_dir():
            raise ValueError(f'Non-regular input is unsupported: {entry}')
    return result


def is_inside(path, directory):
    try:
        path.relative_to(directory)
        return True
    except ValueError:
        return False


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--release', type=Path, required=True,
                    help='Prepared baseline extension root containing manifest.json')
parser.add_argument('--background', type=Path, required=True,
                    help='Isolated build-background.cjs output directory')
parser.add_argument('--output', type=Path, required=True,
                    help='New extension output directory')
parser.add_argument('--files-manifest', type=Path,
                    help='New external JSON path; defaults to OUTPUT.manifest.json')
parser.add_argument('--expected-version', default='0.94.12')
args = parser.parse_args()

release = args.release.resolve(strict=True)
background = args.background.resolve(strict=True)
output = args.output.resolve()
manifest_path = (args.files_manifest or args.output.with_suffix('.manifest.json')).resolve()
if not release.is_dir() or not background.is_dir():
    parser.error('Release and background inputs must be directories')
if os.path.lexists(args.output) or os.path.lexists(manifest_path):
    parser.error('Output directory and files manifest must both be new')
if any(is_inside(output, source) or is_inside(source, output)
       for source in (release, background)):
    parser.error('Output must be separate from both input directory trees')
if any(is_inside(manifest_path, source) for source in (release, background, output)):
    parser.error('Files manifest must be outside the input and output trees')

release_files = files_under(release)
background_files = files_under(background)
manifest_bytes = (release / 'manifest.json').read_bytes()
manifest = json.loads(manifest_bytes)
if manifest.get('manifest_version') != 3 or manifest.get('version') != args.expected_version:
    parser.error('Unexpected release manifest version')
worker_name = manifest.get('background', {}).get('service_worker')
if not isinstance(worker_name, str):
    parser.error('Expected an MV3 background service worker')
worker_path = PurePosixPath(worker_name)
if worker_path.is_absolute() or '..' in worker_path.parts:
    parser.error('Invalid service-worker path in the release manifest')
if worker_name not in release_files or 'background.js' not in release_files:
    parser.error('Release is missing its service worker or background.js')
if 'webextension-polyfill.js' not in release_files:
    parser.error('Release is missing its shared WebExtension polyfill')
if 'background.js' not in background_files or not background_files['background.js'].stat().st_size:
    parser.error('Compiled background.js is missing or empty')
if 'background.js' not in release_files[worker_name].read_text():
    parser.error('Service worker does not reference the expected background bundle')

reserved = {
    'manifest.json', worker_name, 'webextension-polyfill.js',
    'ui.js', 'content-script.js', 'pageProvider.js', 'offscreen.js',
}
if reserved.intersection(background_files):
    parser.error('Background output contains files belonging to the retained released runtime')

before = {name: digest(path) for name, path in release_files.items()}
compiled = {name: digest(path) for name, path in background_files.items()}
output.parent.mkdir(parents=True, exist_ok=True)
shutil.copytree(release, output)
for name, source in background_files.items():
    destination = output / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)

if (output / 'manifest.json').read_bytes() != manifest_bytes:
    raise RuntimeError('Assembly changed the released manifest')
for name in reserved.intersection(release_files):
    if digest(output / name) != before[name]:
        raise RuntimeError(f'Assembly changed a retained release entry: {name}')
after = {name: digest(path) for name, path in files_under(output).items()}
if any(after.get(name) != value for name, value in compiled.items()):
    raise RuntimeError('An assembled compiled asset does not match its build output')
if not (output / worker_name).is_file() or not (output / 'background.js').is_file():
    raise RuntimeError('Assembled extension is missing its background entry')

changed = [name for name in before if after[name] != before[name]]
added = [name for name in after if name not in before]
record = {
    'method': 'Source-built background and its assets over a prepared official release; retained released UI/content/offscreen. This is a hybrid, not a full source-built extension.',
    'releaseVersion': manifest['version'],
    'manifestVersion': manifest['manifest_version'],
    'serviceWorker': worker_name,
    'backgroundSha256': after['background.js'],
    'compiledAssetCount': len(compiled),
    'changedReleasedFiles': changed,
    'addedFiles': added,
    'unchangedReleasedFileCount': len(before) - len(changed),
    'compiledAssets': compiled,
    'files': after,
}
manifest_path.parent.mkdir(parents=True, exist_ok=True)
with manifest_path.open('x') as stream:
    json.dump(record, stream, indent=2)
    stream.write('\n')
print(json.dumps({
    'output': str(output),
    'filesManifest': str(manifest_path),
    'backgroundSha256': record['backgroundSha256'],
    'compiledAssetCount': len(compiled),
    'assembledFileCount': len(after),
    'retainedManifestUnchanged': True,
}))
