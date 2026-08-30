import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';

await esbuild.build({
  entryPoints: ['src/test/roundtrip.ts'],
  bundle: true,
  format: 'cjs',
  outfile: 'dist/roundtrip-test.cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  logLevel: 'warning'
});

execFileSync(process.execPath, ['dist/roundtrip-test.cjs'], {
  cwd: process.cwd(),
  stdio: 'inherit'
});
