#!/usr/bin/env python3
"""Run both unmodified production build configurations in one pinned source tree."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import zipfile

BASE = 'c3aed73f4c5f1e7c88c31331b0b0b72c6e8f2f4a'
FIX = 'd5ab02625b402364d09e556bcfb6c3bfe081831a'
PATCH_SHA256 = '6ad6155e40541972dfa7b3d18027f1d3c49cf75861f025f15342d499f4fab895'
FIX_FILES = {
    'src/utils/message.ts': '181059d4edb4130b9f8b83ec12943097c35aeb7768b7492dae734427a4c90718',
    '__tests__/utils/sendReadyMessageToTabs.test.ts': 'a84503eed64ba62784685f398dd58e55813b9e9113ab283c0a58ec5591bf82f8',
}
GENERATED = ['SecSDK/policy.json', 'src/ui/style/cssvars.css',
             'src/ui/style/var-defs.ts']
CHANGED = ['src/utils/message.ts', '__tests__/utils/sendReadyMessageToTabs.test.ts']
SETUP_PAGE = b'<!doctype html><html><head><meta charset="utf-8"><title>Local Rabby test setup</title></head><body>Isolated watch-only test setup.</body></html>\n'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def inventory(directory):
    result = {}
    for entry in sorted(directory.rglob('*')):
        if entry.is_symlink():
            raise ValueError(f'Unexpected output symlink: {entry}')
        if entry.is_file():
            result[entry.relative_to(directory).as_posix()] = {
                'bytes': entry.stat().st_size,
                'sha256': digest(entry.read_bytes()),
            }
    return result


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
source, output = args.source.resolve(), args.output.resolve()
evidence = Path(__file__).resolve().parent.parent
if output.exists():
    parser.error('Output must be new')
output.mkdir(parents=True)


def git(*args):
    return subprocess.check_output(['git', '-C', str(source), *args])


def command(name, argv, cwd=source, required=True):
    started = time.monotonic()
    print(json.dumps({'stage': name, 'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}), flush=True)
    with (output / (name + '.log')).open('wb') as log:
        process = subprocess.run(argv, cwd=cwd, env=build_env, stdout=log,
                                 stderr=subprocess.STDOUT, check=False)
    (output / (name + '.exitcode')).write_text(str(process.returncode) + '\n')
    record = {'command': argv, 'exitCode': process.returncode,
              'elapsedSeconds': time.monotonic() - started,
              'logSha256': digest((output / (name + '.log')).read_bytes())}
    write_json(output / (name + '.command.json'), record)
    print(json.dumps({'stage': name, **record}), flush=True)
    if required and process.returncode:
        raise RuntimeError(f'{name} failed; raw log and exit code retained')
    return record


build_env = os.environ.copy()
for name in ['FORK_TS_CHECKER', 'sourcemap', 'VERSION', 'NODE_ENV',
             'ETHERSCAN_KEY', 'RABBY_SENTRY_DSN']:
    build_env.pop(name, None)
build_env['MANIFEST_TYPE'] = 'chrome-mv3'
yarn = ['node', str(source / '.yarn/releases/yarn-4.14.1.cjs')]
patch = evidence / 'patches/pwa-ready.patch'
summary = {'baseCommit': BASE, 'fixCommitWhosePatchIsApplied': FIX,
           'candidateMethod': 'Same checkout with HEAD at base commit; apply exact two-file PR patch. Build revision metadata therefore stays equal.',
           'patchSha256': digest(patch.read_bytes()), 'variants': {}}
try:
    if digest(patch.read_bytes()) != PATCH_SHA256:
        raise ValueError('The patch no longer matches the tested PR commit')
    if git('rev-parse', 'HEAD').decode().strip() != BASE:
        raise ValueError('Wrong source HEAD')
    if git('status', '--porcelain').strip():
        raise ValueError('Expected clean pinned source before installation')
    summary['nodeVersion'] = subprocess.check_output(['node', '--version']).decode().strip()
    summary['yarnVersion'] = subprocess.check_output(yarn + ['--version'], cwd=source).decode().strip()
    if summary['yarnVersion'] != '4.14.1':
        raise ValueError('Wrong Yarn version')
    summary['lockSha256'] = digest((source / 'yarn.lock').read_bytes())
    command('install', yarn + ['install', '--immutable'])
    if git('status', '--porcelain').strip():
        raise ValueError('Dependency installation changed tracked source or added unignored files')
    original_generated = {name: (source / name).read_bytes() for name in GENERATED}
    original_manifest = (source / 'src/manifest/chrome-mv3/manifest.json').read_bytes()
    for variant in ['baseline', 'candidate']:
        for name, data in original_generated.items():
            (source / name).write_bytes(data)
        if variant == 'candidate':
            git('apply', '--check', str(patch))
            git('apply', str(patch))
            for name, expected_hash in FIX_FILES.items():
                if digest((source / name).read_bytes()) != expected_hash:
                    raise ValueError(f'Patched source differs from PR commit: {name}')
        changed_before = git('diff', '--name-only').decode().splitlines()
        expected = CHANGED if variant == 'candidate' else []
        # New test files are untracked after git apply and are recorded separately.
        untracked_before = git('ls-files', '--others', '--exclude-standard').decode().splitlines()
        if set(changed_before + untracked_before) != set(expected):
            raise ValueError(f'Unexpected prebuild source changes: {changed_before + untracked_before}')
        phase = output / variant
        phase.mkdir()
        write_json(phase / 'source.json', {
            'gitHead': git('rev-parse', 'HEAD').decode().strip(),
            'changedTracked': changed_before, 'untracked': untracked_before,
            'inputPolicySha256': digest((source / 'SecSDK/policy.json').read_bytes()),
            'helperSha256': digest((source / 'src/utils/message.ts').read_bytes()),
            'lockSha256': digest((source / 'yarn.lock').read_bytes()),
        })
        command(variant + '-config', ['node', str(evidence / 'scripts/inspect-production-config.cjs'),
                                     str(source), str(phase / 'production-config.json')])
        build = command(variant + '-production-build', yarn + ['build:pro'])
        changed_after = git('diff', '--name-only').decode().splitlines()
        if not set(changed_after).issubset(set(GENERATED + expected)):
            raise ValueError(f'Unexpected source mutation during build: {changed_after}')
        untracked_after = git('ls-files', '--others', '--exclude-standard').decode().splitlines()
        if untracked_after != untracked_before:
            raise ValueError(f'Unexpected untracked source output: {untracked_after}')
        (phase / 'generated-source.diff').write_bytes(git('diff', '--', *GENERATED))
        for name in GENERATED:
            target = phase / 'generated' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((source / name).read_bytes())
        dist = source / 'dist'
        files = inventory(dist)
        required_files = ['manifest.json', 'sw.js', 'background.js', 'content-script.js',
                          'pageProvider.js', 'ui.js', 'offscreen.js', 'webextension-polyfill.js',
                          'warden-policy-runtime.js', 'popup.html', 'notification.html',
                          'index.html', 'desktop.html', 'background.html', 'offscreen.html']
        for name in required_files:
            if not files.get(name, {}).get('bytes'):
                raise ValueError(f'Missing full production output: {name}')
        if (dist / 'manifest.json').read_bytes() != original_manifest:
            raise ValueError('Production manifest differs from pinned source manifest')
        write_json(phase / 'pristine-dist.json', files)
        tested = output.parent.parent / ('full-source-' + variant + '-extension')
        if tested.exists():
            raise ValueError('Tested extension output must be new')
        shutil.copytree(dist, tested)
        if (tested / 'reliability-probe.html').exists():
            raise ValueError('Static setup file unexpectedly part of source dist')
        (tested / 'reliability-probe.html').write_bytes(SETUP_PAGE)
        tested_files = inventory(tested)
        if set(tested_files) != set(files) | {'reliability-probe.html'} or any(tested_files[n] != v for n, v in files.items()):
            raise ValueError('Browser preparation changed a compiled file')
        write_json(phase / 'tested-dist.json', tested_files)
        archive = output / (variant + '-tested-extension.zip')
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
            for name in tested_files:
                bundle.write(tested / name, name)
        summary['variants'][variant] = {
            'build': build, 'compiledFiles': len(files), 'testedFiles': len(tested_files),
            'onlyTestAddition': 'reliability-probe.html',
            'archiveSha256': digest(archive.read_bytes()),
            'testedExtension': str(tested),
            'manifestUnchanged': True,
            'generatedPolicySha256': digest((source / 'SecSDK/policy.json').read_bytes()),
        }
    for name, data in original_generated.items():
        (source / name).write_bytes(data)
    command('candidate-check', yarn + ['check'])
    # Jest transpilation follows the existing local test protocol; yarn check above
    # independently enforces source typing and linting.
    jest_config = output / 'jest-full-source.cjs'
    jest_config.write_text("const c=require(" + json.dumps(str(source / 'jest.config.js')) + ");c.rootDir=" + json.dumps(str(source)) + ";for(const x of Object.values(c.transform)){if(Array.isArray(x)&&x[0]==='ts-jest')x[1]={...x[1],isolatedModules:true,diagnostics:false}};module.exports=c;\n")
    command('candidate-tests', yarn + ['test', '--config', str(jest_config),
            '__tests__/utils/sendReadyMessageToTabs.test.ts', '__tests__/utils/portMessage.test.ts',
            '--runInBand', '--watchman=false'])
    baseline_files = json.loads((output / 'baseline/pristine-dist.json').read_text())
    candidate_files = json.loads((output / 'candidate/pristine-dist.json').read_text())
    summary['assetComparison'] = {
        'added': sorted(set(candidate_files) - set(baseline_files)),
        'removed': sorted(set(baseline_files) - set(candidate_files)),
        'changed': sorted(n for n in baseline_files.keys() & candidate_files.keys() if baseline_files[n] != candidate_files[n]),
    }
    summary['completed'] = True
except Exception as error:
    summary['completed'] = False
    summary['error'] = str(error)
    raise
finally:
    write_json(output / 'build-pair.json', summary)
