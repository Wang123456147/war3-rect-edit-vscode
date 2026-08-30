import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info'
};

const extensionOptions = {
  ...common,
  entryPoints: ['src/extension.ts'],
  external: ['vscode'],
  format: 'cjs',
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node20'
};

const webviewOptions = {
  ...common,
  entryPoints: ['src/webview/main.ts'],
  format: 'iife',
  outfile: 'dist/webview.js',
  platform: 'browser',
  target: 'chrome120',
  alias: {
    events: './src/webview/event-emitter.ts',
    'tga-js': './node_modules/tga-js/dist/esm/tga.js'
  }
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extensionOptions),
    esbuild.context(webviewOptions)
  ]);
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('War3 Map Tools: watching for changes');
  await new Promise(() => {});
} else {
  await Promise.all([
    esbuild.build(extensionOptions),
    esbuild.build(webviewOptions)
  ]);
}
