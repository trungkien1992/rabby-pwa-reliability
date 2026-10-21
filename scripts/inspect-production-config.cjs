const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const [sourceArgument, outputArgument] = process.argv.slice(2);
if (process.argv.length !== 4 || !path.isAbsolute(sourceArgument || '') || !path.isAbsolute(outputArgument || '')) {
  throw new Error('Usage: node inspect-production-config.cjs ABS_SOURCE OUTPUT_JSON');
}
const root = fs.realpathSync(sourceArgument);
const output = path.resolve(outputArgument);
const relativeOutput = path.relative(root, output);
if (relativeOutput === '' || (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput))) {
  throw new Error('Preflight output must be outside the source checkout');
}
if (fs.existsSync(output)) throw new Error('Preflight output must be new');
process.chdir(root);
const fromRepo = createRequire(path.join(root, 'package.json'));
const hashBytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile = (file) => hashBytes(fs.readFileSync(file));
const relative = (file) => path.relative(root, file).split(path.sep).join('/');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const watchedFiles = ['SecSDK/policy.json', 'src/ui/style/cssvars.css', 'src/ui/style/var-defs.ts'];
const before = Object.fromEntries(watchedFiles.map((name) => [name, hashFile(path.join(root, name))]));
const statusBefore = git('status', '--porcelain');
const checks = [];
const requireCondition = (condition, name) => {
  checks.push({ name, passed: Boolean(condition) });
  if (!condition) throw new Error(name);
};
const result = {
  schemaVersion: 1,
  purpose: 'Read-only inspection of the actual upstream production webpack configuration; no compiler is run',
  sourceRoot: root,
  sourceCommit: git('rev-parse', 'HEAD'),
  sourceStatus: statusBefore,
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
  availableParallelism: os.availableParallelism?.() ?? os.cpus().length,
  systemMemoryBytes: os.totalmem(),
  checks,
};

try {
  for (const name of ['FORK_TS_CHECKER', 'sourcemap', 'VERSION', 'NODE_ENV', 'ETHERSCAN_KEY', 'RABBY_SENTRY_DSN']) {
    requireCondition(!process.env[name], `Unexpected ${name} environment is absent`);
  }
  requireCondition(!process.env.MANIFEST_TYPE || process.env.MANIFEST_TYPE === 'chrome-mv3', 'Manifest environment matches yarn build:pro');
  process.env.MANIFEST_TYPE = 'chrome-mv3';
  const config = fromRepo('./webpack.config.js')({ config: 'pro' });
  const { WardenPlugin } = fromRepo('warden-for-js');
  const TerserPlugin = fromRepo('terser-webpack-plugin');
  requireCondition(config.mode === 'production', 'Production mode is enabled');
  requireCondition(config.devtool === false && config.watch !== true, 'Production source maps and watch mode are disabled');
  const expectedEntries = {
    background: 'src/background/index.ts',
    'content-script': 'src/content-script/index.ts',
    pageProvider: 'src/content-script/page-provider.ts',
    ui: 'src/ui/index.tsx',
    offscreen: 'src/offscreen/scripts/offscreen.ts',
  };
  requireCondition(JSON.stringify(Object.keys(config.entry).sort()) === JSON.stringify(Object.keys(expectedEntries).sort()), 'All five upstream entries are present');
  for (const [name, file] of Object.entries(expectedEntries)) {
    const entry = config.entry[name];
    requireCondition((typeof entry === 'string' ? entry : entry.import) === path.join(root, file), `Original ${name} entry is retained`);
  }
  requireCondition(config.entry.background.asyncChunks === false, 'Background asyncChunks remains false');
  requireCondition(config.output.path === path.join(root, 'dist') && config.output.filename === '[name].js' && !config.output.library, 'Original dist output is retained');
  requireCondition(config.optimization.minimize === true, 'Production minification is enabled');
  const minimizers = config.optimization.minimizer || [];
  requireCondition(minimizers.length === 1 && minimizers[0] instanceof TerserPlugin, 'Original Terser minifier is retained');
  const minifier = minimizers[0];
  requireCondition(minifier.options.parallel === true, 'Upstream minifier parallel setting is retained');
  requireCondition(JSON.stringify(minifier.options.minimizer.options.compress.pure_funcs) === JSON.stringify(['console.log', 'console.debug', 'console.info']), 'Original Terser compression policy is retained');
  const polyfill = config.optimization.splitChunks?.cacheGroups?.['webextension-polyfill'];
  requireCondition(polyfill?.chunks === 'all' && polyfill?.name === 'webextension-polyfill' && polyfill?.priority === 100, 'Shared WebExtension polyfill splitting is retained');

  const plugins = config.plugins;
  const named = (name) => plugins.filter((plugin) => plugin.constructor.name === name);
  requireCondition(plugins.length === 13 && named('Object').length === 1 && typeof named('Object')[0].apply === 'function', 'Complete upstream production plugin set and styled-components plugin are retained');
  requireCondition(named('ProvidePlugin').length === 1 && named('DefinePlugin').length === 2, 'Upstream Provide and Define plugins are retained');
  const definitions = Object.assign({}, ...named('DefinePlugin').map((plugin) => plugin.definitions));
  requireCondition(definitions['process.env.BUILD_ENV'] === JSON.stringify('PRO') && !Object.hasOwn(definitions, 'process.env.DEBUG'), 'Production runtime definitions are retained');
  const warden = plugins.filter((plugin) => plugin instanceof WardenPlugin);
  requireCondition(warden.length === 1, 'Exactly one upstream Warden plugin is retained');
  const security = warden[0].config;
  requireCondition(security.dev === false && security.forceCheck === true, 'Warden production checks fail closed');
  requireCondition(security.freezePrototypes === true && security.prototypeFreezeMode === 'compat' && security.protectWebpackRequire === true, 'Upstream Warden prototype and require safeguards are retained');
  requireCondition(security.policyOverPath === 'SecSDK/policy-over.json' && security.policyOutputPath === 'SecSDK/policy.json', 'Original Warden policy paths are retained');
  const html = named('HtmlWebpackPlugin');
  const expectedHtml = ['popup.html', 'notification.html', 'index.html', 'desktop.html', 'background.html', 'offscreen.html'];
  requireCondition(html.length === 6 && JSON.stringify(html.map((plugin) => plugin.userOptions.filename).sort()) === JSON.stringify(expectedHtml.sort()), 'All six upstream HTML outputs are retained');
  requireCondition(html.every((plugin) => plugin.userOptions.inject === true && fs.statSync(plugin.userOptions.template).isFile()), 'Upstream HTML templates and script injection are retained');
  const copies = named('CopyPlugin');
  requireCondition(copies.length === 1 && copies[0].patterns.length === 5, 'Original Chrome MV3 Copy plugin and five patterns are retained');
  const copyPatterns = copies[0].patterns;
  requireCondition(copyPatterns[0].from === path.join(root, '_raw') && copyPatterns[0].to === path.join(root, 'dist'), 'All raw runtime assets are copied by the original rule');
  requireCondition(copyPatterns[1].from === path.join(root, 'src/manifest/chrome-mv3/manifest.json') && copyPatterns[1].to === path.join(root, 'dist/manifest.json'), 'Original production manifest copy is retained');
  for (const pattern of copyPatterns) requireCondition(fs.existsSync(pattern.from), `Copy input exists: ${relative(pattern.from)}`);
  const eslint = named('ESLintWebpackPlugin');
  requireCondition(eslint.length === 1 && eslint[0].options.failOnError === true && !eslint[0].options.lintDirtyModulesOnly, 'Full upstream ESLint checks remain blocking');
  requireCondition(named('ForkTsCheckerWebpackPlugin').length === 0, 'Default non-fork TypeScript build path is retained');
  const tsLoaders = [];
  const inspectRule = (rule, location) => {
    if (!rule || typeof rule !== 'object') return;
    if ((rule.loader || '').includes('ts-loader')) tsLoaders.push({ location, transpileOnly: rule.options?.transpileOnly === true, onlyCompileBundledFiles: rule.options?.onlyCompileBundledFiles === true });
    for (const key of ['oneOf', 'rules', 'use']) {
      const values = rule[key] ? (Array.isArray(rule[key]) ? rule[key] : [rule[key]]) : [];
      values.forEach((value, index) => inspectRule(value, `${location}.${key}[${index}]`));
    }
  };
  config.module.rules.forEach((rule, index) => inspectRule(rule, `module.rules[${index}]`));
  requireCondition(tsLoaders.length === 3 && tsLoaders.filter((loader) => loader.transpileOnly).length === 1 && tsLoaders.every((loader) => !loader.onlyCompileBundledFiles), 'Original TypeScript checking/transpilation scopes are retained');
  requireCondition(tsLoaders.find((loader) => loader.transpileOnly)?.location === 'module.rules[0].oneOf[1].use[0]', 'Only the original UI loader uses transpile-only mode');
  const manifestFile = path.join(root, 'src/manifest/chrome-mv3/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  requireCondition(manifest.manifest_version === 3 && manifest.background?.service_worker === 'sw.js', 'Chrome MV3 service-worker manifest is retained');
  requireCondition(fs.statSync(path.join(root, '_raw/sw.js')).isFile() && fs.statSync(path.join(root, 'SecSDK/check.json')).isFile(), 'Service-worker loader and sensitive-global checks exist');

  const sourceFiles = ['package.json', 'yarn.lock', '.yarnrc.yml', '.yarn/releases/yarn-4.14.1.cjs', 'webpack.config.js', 'build/webpack.common.config.js', 'build/webpack.pro.config.js', 'build/paths.js', 'build/manifest-utils.js', 'build/clean.js', 'scripts/make-theme.js', 'tsconfig.json', 'src/manifest/chrome-mv3/manifest.json', 'SecSDK/policy-over.json', 'SecSDK/check.json', '_raw/sw.js', 'src/utils/message.ts'];
  result.sourceFileSha256 = Object.fromEntries(sourceFiles.map((file) => [file, hashFile(path.join(root, file))]));
  const dependencies = ['webpack', 'terser-webpack-plugin', 'warden-for-js', 'typescript', 'ts-loader', 'html-webpack-plugin', 'copy-webpack-plugin', 'eslint-webpack-plugin', 'typescript-plugin-styled-components', 'webextension-polyfill', '@trezor/connect-web', '@trezor/connect-webextension'];
  result.dependencies = {};
  for (const name of dependencies) {
    const entry = fs.realpathSync(fromRepo.resolve(name));
    const entryRelative = relative(entry);
    requireCondition(entryRelative.startsWith('node_modules/'), `Dependency resolves inside source root: ${name}`);
    let directory = path.dirname(entry);
    let packageFile;
    while (directory !== path.dirname(directory)) {
      const candidate = path.join(directory, 'package.json');
      if (fs.existsSync(candidate) && JSON.parse(fs.readFileSync(candidate, 'utf8')).name === name) { packageFile = candidate; break; }
      directory = path.dirname(directory);
    }
    requireCondition(Boolean(packageFile), `Dependency package metadata exists: ${name}`);
    result.dependencies[name] = { version: JSON.parse(fs.readFileSync(packageFile, 'utf8')).version, packageFile: relative(packageFile), packageSha256: hashFile(packageFile), entry: entryRelative, entrySha256: hashFile(entry) };
  }
  result.configuration = {
    mode: config.mode,
    entries: expectedEntries,
    outputPath: relative(config.output.path),
    minimize: config.optimization.minimize,
    minifier: minifier.constructor.name,
    plugins: plugins.map((plugin) => plugin.constructor.name),
    htmlOutputs: html.map((plugin) => plugin.userOptions.filename),
    copyPatterns: copyPatterns.map((pattern) => ({ from: relative(pattern.from), to: relative(pattern.to) })),
    warden: { ...security },
    tsLoaders,
    manifestVersion: manifest.manifest_version,
    extensionVersion: manifest.version,
    embeddedBuildRevision: definitions['process.env.RABBY_BUILD_GIT_HASH'],
    factoryInvocation: { config: 'pro', MANIFEST_TYPE: 'chrome-mv3' },
    configurationObjectModified: false,
  };
  result.status = 'passed';
} catch (error) {
  result.status = 'failed';
  result.error = error.message;
}

result.sourceFileIdentityAfterInspection = Object.fromEntries(watchedFiles.map((name) => [name, hashFile(path.join(root, name))]));
result.sourceFilesUnchanged = Object.entries(before).every(([name, value]) => result.sourceFileIdentityAfterInspection[name] === value) && git('status', '--porcelain') === statusBefore;
if (!result.sourceFilesUnchanged) { result.status = 'failed'; result.error = 'Configuration inspection changed source files'; }
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: result.status, output, checks: checks.length, sourceFilesUnchanged: result.sourceFilesUnchanged }));
if (result.status !== 'passed') console.error(result.error);
process.exitCode = result.status === 'passed' ? 0 : 1;
