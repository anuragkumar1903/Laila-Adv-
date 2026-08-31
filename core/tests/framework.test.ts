import { test } from 'node:test';
import assert from 'node:assert';
import { detectFrameworkFromPkg, detectFrameworkFromFiles } from '../src/scanner/detectors/framework.js';

test('Framework Detection', async (t) => {
  await t.test('detects Express.js from package.json', () => {
    const framework = detectFrameworkFromPkg({
      dependencies: { express: '^4.17.1' }
    });
    assert.strictEqual(framework, 'Express.js');
  });

  await t.test('detects Next.js with priority over React', () => {
    const framework = detectFrameworkFromPkg({
      dependencies: { react: '^18', next: '^13' }
    });
    assert.strictEqual(framework, 'Next.js'); // Next is higher in DEP_FRAMEWORK_MAP
  });

  await t.test('detects Django from file markers', () => {
    const framework = detectFrameworkFromFiles(['src/main.py', 'manage.py']);
    assert.strictEqual(framework, 'Django');
  });

  await t.test('detects Go from go.mod', () => {
    const framework = detectFrameworkFromFiles(['cmd/server/main.go', 'go.mod']);
    assert.strictEqual(framework, 'Go');
  });

  await t.test('returns null if no framework is matched', () => {
    const pkgResult = detectFrameworkFromPkg({ dependencies: { 'left-pad': '^1.3.0' } });
    assert.strictEqual(pkgResult, null);

    const fileResult = detectFrameworkFromFiles(['unknown.txt']);
    assert.strictEqual(fileResult, null);
  });
});
