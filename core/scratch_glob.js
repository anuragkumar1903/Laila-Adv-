import { glob } from 'glob';
async function test() {
  const rawPaths = await glob('*', { cwd: 'P:\\', nodir: true });
  console.log(rawPaths.slice(0, 5));
}
test();
