#!/usr/bin/env python3
"""Additional full-source gates; the existing browser verifier stays unchanged."""
import hashlib
import json
from pathlib import Path
import sys

VERIFIER = '3743f77a252562c73121ba3d1272d5bf7b402ed83c9c10ce2b830f3e9a952397'
PATCH = '6ad6155e40541972dfa7b3d18027f1d3c49cf75861f025f15342d499f4fab895'
root = Path(sys.argv[1])
report = {'passed': False, 'pairsRequired': 3, 'pairs': []}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


try:
    build = json.loads((root / 'build/build-pair.json').read_text())
    assert build['completed'] is True, 'Both full production builds must complete'
    assert build['patchSha256'] == PATCH, 'Patch provenance differs'
    assert build['yarnVersion'] == '4.14.1', 'Yarn pin differs'
    assert sha(Path(__file__).parent / 'verify-results.mjs') == VERIFIER, 'Strict verifier changed'
    policies = []
    for variant in ['baseline', 'candidate']:
        meta = build['variants'][variant]
        assert meta['build']['exitCode'] == 0 and meta['manifestUnchanged'] is True
        assert sha(root / 'build' / (variant + '-tested-extension.zip')) == meta['archiveSha256']
        source = json.loads((root / 'build' / variant / 'source.json').read_text())
        policies.append(source['inputPolicySha256'])
        assert source['lockSha256'] == build['lockSha256']
        pristine = json.loads((root / 'build' / variant / 'pristine-dist.json').read_text())
        tested = json.loads((root / 'build' / variant / 'tested-dist.json').read_text())
        assert set(tested) == set(pristine) | {'reliability-probe.html'}
        assert all(tested[name] == info for name, info in pristine.items()), 'A compiled runtime asset was modified'
    assert len(set(policies)) == 1, 'Builds did not start from the same security policy'
    assert build['variants']['baseline']['generatedPolicySha256'] == build['variants']['candidate']['generatedPolicySha256'], 'Generated security policies differ'
    for command in ['candidate-check', 'candidate-tests']:
        assert (root / 'build' / (command + '.exitcode')).read_text().strip() == '0'
    profiles = []
    for pair in range(1, 4):
        comparison_path = root / 'runtime' / f'pair-{pair}-comparison.json'
        comparison = json.loads(comparison_path.read_text())
        assert comparison['passed'] is True, f'Pair {pair}: strict comparison failed'
        assert comparison['verifierSha256'] == VERIFIER
        for entry in comparison['inputs']:
            assert sha(root / 'runtime' / entry['file']) == entry['sha256'], 'Comparison input hash differs'
        for variant in ['baseline', 'candidate']:
            path = root / 'runtime' / f'pair-{pair}-{variant}.json'
            run = json.loads(path.read_text())
            assert (path.with_suffix('.exitcode')).read_text().strip() == '0'
            assert run['platform'] == 'linux' and run['minimizeConfirmed'] is True
            assert run['uiSmoke']['passed'] is True, 'Actual wallet UI smoke did not pass'
            assert not run['uiSmoke']['uncaughtExceptions'] and not run['uiSmoke']['remainingUiTargets']
            assert all(target['targetDestroyedObserved'] is True for target in run['uiSmoke']['closedUiTargets'])
            inventory_path = root / 'build' / variant / 'tested-dist.json'
            assets = json.loads(inventory_path.read_text())
            binding = run['extensionAssets']
            assert binding['matchedBefore'] is True and binding['matchedAfter'] is True
            assert binding['expectedManifestSha256'] == sha(inventory_path)
            assert binding['checkedFileCount'] == len(assets)
            for field, name in [('backgroundSha256', 'background.js'), ('uiSha256', 'ui.js'), ('manifestSha256', 'manifest.json')]:
                assert binding[field] == assets[name]['sha256'], 'Runtime/source-built asset identity differs'
            assert run['extensionPath'] == build['variants'][variant]['testedExtension']
            for setup in [run['initialSetup'], run['regularControl']['initialSetup']]:
                assert setup['status'] == 'ready' and setup['timeoutMs'] == 5000 and setup['elapsedMs'] <= 5000
                final = setup['finalSnapshot']
                assert final['documentReadyState'] == 'complete'
                assert all(final[field] is True for field in ['hasRabby', 'providerReady', 'providerInitialized', 'stateInitialized'])
                assert final['cachedRequestCount'] == 0 and final['waitingCount'] == 0
            profiles.append(run['profile'])
        report['pairs'].append({'pair': pair, 'strictComparisonPassed': True,
                                'comparisonSha256': sha(comparison_path)})
    assert len(profiles) == len(set(profiles)) == 6, 'Expected six fresh profiles, no retry/reuse'
    report.update({'passed': True, 'strictVerifierSha256': VERIFIER,
                   'buildPairSha256': sha(root / 'build/build-pair.json'),
                   'scope': 'Three independent controlled worker restarts per variant on complete source-built production extensions. No natural-resume or production-performance claim.'})
except Exception as error:
    report['error'] = str(error)
print(json.dumps(report, indent=2))
sys.exit(0 if report['passed'] else 1)
