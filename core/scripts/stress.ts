import { spawn } from 'child_process';
import os from 'os';

async function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

console.log(`\n======================================================`);
console.log(`🔥 LAILA OS EXTREME STRESS TEST (PONYTAIL EDITION) 🔥`);
console.log(`======================================================`);
console.log(`💻 Host CPU Cores: ${os.cpus().length}`);
console.log(`🧠 Host Memory: ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`);
console.log(`⚡ Concurrency: 5 simultaneous Swarm-like DB/RAG bursts\n`);

const NUM_INSTANCES = 5;
let completed = 0;

async function poundLaila(id: number) {
  const start = Date.now();
  return new Promise<void>((resolve) => {
    // Force Laila to boot up, scan the SQLite memory graph, hit the RAG engine, and exit
    const child = spawn('node', ['dist/cli/index.js', 'scan'], {
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '1' }
    });

    let output = '';
    child.stdout?.on('data', d => output += d.toString());
    child.stderr?.on('data', d => output += d.toString());

    child.on('close', (code) => {
      completed++;
      const timeMs = Date.now() - start;
      if (code === 0) {
        console.log(`✅ [Thread ${id}] Survived! (Time: ${timeMs}ms)`);
      } else {
        console.log(`❌ [Thread ${id}] Failed/Locked under stress. (Time: ${timeMs}ms)`);
      }
      resolve();
    });
  });
}

async function runTest() {
  const start = Date.now();
  const promises = [];
  
  for (let i = 1; i <= NUM_INSTANCES; i++) {
    console.log(`🚀 Spawning Laila Agent Thread #${i}...`);
    promises.push(poundLaila(i));
    // Tiny delay to ensure stdout formatting doesn't totally break
    await delay(50);
  }

  await Promise.all(promises);
  
  console.log(`\n🏁 STRESS TEST COMPLETE in ${(Date.now() - start)}ms`);
  console.log(`If you see all ✅, Laila's WAL-mode SQLite database successfully handled`);
  console.log(`highly concurrent thread operations without throwing SQLITE_BUSY locks.`);
}

runTest();
