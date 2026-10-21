const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');

const [sourceDirectory, outputDirectory] = process.argv.slice(2);
if (
  process.argv.length !== 4 ||
  !path.isAbsolute(sourceDirectory || '') ||
  !path.isAbsolute(outputDirectory || '')
) {
  throw new Error('Usage: node build-background.cjs ABS_SOURCE_DIR ABS_OUTPUT_DIR');
}

const root = fs.realpathSync(sourceDirectory);
const output = path.resolve(outputDirectory);
const relativeOutput = path.relative(root, output);
if (
  relativeOutput === '' ||
  (!relativeOutput.startsWith(`..${path.sep}`) &&
    relativeOutput !== '..' &&
    !path.isAbsolute(relativeOutput))
) {
  throw new Error('The background output directory must be outside the source checkout');
}

process.chdir(root);
process.env.MANIFEST_TYPE = 'chrome-mv3';
delete process.env.FORK_TS_CHECKER;
delete process.env.ETHERSCAN_KEY;
delete process.env.RABBY_SENTRY_DSN;

const fromRepo = createRequire(path.join(root, 'package.json'));
const webpack = fromRepo('webpack');
const { WardenPlugin } = fromRepo('warden-for-js');
const config = fromRepo('./webpack.config.js')({ config: 'pro' });
const removedPluginNames = new Set([
  'CopyPlugin',
  'HtmlWebpackPlugin',
  'ESLintWebpackPlugin',
  'ForkTsCheckerWebpackPlugin',
]);
const removedPlugins = config.plugins
  .filter((plugin) => removedPluginNames.has(plugin.constructor.name))
  .map((plugin) => plugin.constructor.name);
config.plugins = config.plugins.filter(
  (plugin) => !removedPluginNames.has(plugin.constructor.name)
);

const policySource = path.join(root, 'SecSDK/policy.json');
const policyBefore = fs.readFileSync(policySource);
const wardenPolicyOutput = path.join(output, 'SecSDK/policy.json');
let redirectedWardenPlugins = 0;
config.plugins = config.plugins.map((plugin) => {
  if (!(plugin instanceof WardenPlugin)) return plugin;
  if (!plugin.config || typeof plugin.config !== 'object') {
    throw new Error('Cannot inspect upstream Warden security options');
  }
  redirectedWardenPlugins += 1;
  return new WardenPlugin({
    ...plugin.config,
    policyOutputPath: wardenPolicyOutput,
  });
});
if (redirectedWardenPlugins !== 1) {
  throw new Error('Expected exactly one upstream Warden plugin');
}

const source = path.join(root, 'src/background/index.ts');
const changedHelper = path.join(root, 'src/utils/message.ts');
config.entry = {
  background: { import: source, asyncChunks: false },
};
config.output = {
  ...config.output,
  path: output,
  filename: '[name].js',
  uniqueName: 'rabby-background-reliability-probe',
};
config.watch = false;
config.cache = false;
config.devtool = false;
config.optimization = {
  ...config.optimization,
  minimize: false,
  // Embed dependencies so the rebuilt worker does not replace a shared chunk
  // still used by the unchanged released UI, content script and offscreen page.
  splitChunks: false,
  runtimeChunk: false,
};

const restrictTypeScriptCompilation = (rule) => {
  if (!rule || typeof rule !== 'object') return;
  if ((rule.loader || '').includes('ts-loader')) {
    rule.options = {
      ...rule.options,
      transpileOnly: true,
      onlyCompileBundledFiles: true,
    };
  }
  for (const key of ['oneOf', 'rules', 'use']) {
    const entries = rule[key]
      ? Array.isArray(rule[key])
        ? rule[key]
        : [rule[key]]
      : [];
    entries.forEach(restrictTypeScriptCompilation);
  }
};
config.module.rules.forEach(restrictTypeScriptCompilation);

const digest = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
console.log(
  JSON.stringify({
    purpose: 'Source-built background for a disclosed hybrid extension comparison',
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    source,
    sourceSha256: digest(source),
    changedHelper,
    changedHelperSha256: digest(changedHelper),
    output,
    retainedPlugins: config.plugins.map((plugin) => plugin.constructor.name),
    removedPlugins,
    wardenPolicyOutput,
    sourcePolicySha256: crypto
      .createHash('sha256')
      .update(policyBefore)
      .digest('hex'),
    checks: 'TypeScript transpilation only; full type/lint checks are separate',
    packaging: 'Retain released sw.js, webextension-polyfill.js and all UI/content/offscreen files; replace background.js and copy every emitted background asset.',
  })
);

const compiler = webpack(config);
compiler.run((error, stats) => {
  let failed = Boolean(error);
  if (error) console.error(error);
  if (stats) {
    failed ||= stats.hasErrors();
    console.log(
      stats.toString({
        all: false,
        errors: true,
        warnings: true,
        assets: true,
        timings: true,
      })
    );
    console.log(
      JSON.stringify({
        emittedFiles: stats.compilation.getAssets().map(({ name, source }) => ({
          name,
          bytes: source.size(),
          sha256: fs.existsSync(path.join(output, name))
            ? digest(path.join(output, name))
            : null,
        })),
        hasErrors: stats.hasErrors(),
      })
    );
  }
  compiler.close((closeError) => {
    if (closeError) console.error(closeError);
    const sourcePolicyUnchanged = fs.readFileSync(policySource).equals(policyBefore);
    console.log(JSON.stringify({ sourcePolicyUnchanged }));
    if (!sourcePolicyUnchanged) {
      console.error('Source policy changed during the background build; inspect it before continuing');
    }
    const exitCode = failed || closeError || !sourcePolicyUnchanged ? 1 : 0;
    process.exitCode = exitCode;
    // Some loaders retain handles after compiler.close. This is a one-shot CLI;
    // finish only after compilation closes and its complete log is flushed.
    process.stdout.write('', () => {
      process.stderr.write('', () => process.exit(exitCode));
    });
  });
});
