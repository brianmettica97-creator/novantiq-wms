// Empaqueta el motor + la app de demo (incluido Three.js) en un único HTML autocontenido:
// se abre con doble clic, sin servidor y sin conexión (salvo las fuentes de Google, opcionales).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  entryPoints: [join(root, 'apps/demo/app.js')],
  bundle: true,
  format: 'iife',
  minify: process.env.NOMINIFY ? false : true,
  target: ['es2020'],
  write: false,
  legalComments: 'eof',
  logLevel: 'warning',
});
// "</script" dentro del bundle cerraría la etiqueta antes de tiempo
const bundle = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync(join(root, 'apps/demo/template.html'), 'utf8').replace('/*__ENGINE__*/', () => bundle);
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/wms-demo.html'), html);
console.log('dist/wms-demo.html', (html.length / 1024).toFixed(0) + ' KB');
