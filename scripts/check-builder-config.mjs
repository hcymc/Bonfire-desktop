import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';

// Pre-flight the electron-builder config the way CI does, so an unsupported key is caught
// on this machine instead of six minutes later on six runners.
const root = process.argv[2] || '.';
const scheme = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/app-builder-lib/scheme.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true, useDefaults: false });
const validate = ajv.compile(scheme);
const ok = validate(pkg.build);
const version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/app-builder-lib/package.json'), 'utf8')).version;
console.log('electron-builder', version);
console.log('配置校验:', ok ? '通过' : '失败');
if (!ok) for (const e of validate.errors) console.log(' -', (e.instancePath || '(root)') + ' ' + e.message, e.params && e.params.additionalProperty ? `← 多余键: ${e.params.additionalProperty}` : '');
