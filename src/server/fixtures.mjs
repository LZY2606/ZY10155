import fs from 'node:fs/promises';
import path from 'node:path';

export async function loadFixtures(root = path.resolve('fixtures')) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const fixtures = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    const design = JSON.parse(await fs.readFile(path.join(directory, 'design.json'), 'utf8'));
    const sdcFiles = (await fs.readdir(directory)).filter((name) => name.endsWith('.sdc')).sort();
    const layers = await Promise.all(sdcFiles.map(async (file) => ({
      id: path.basename(file, '.sdc'),
      content: await fs.readFile(path.join(directory, file), 'utf8')
    })));
    fixtures.push({ design, layers });
  }
  return fixtures.sort((left, right) => left.design.id.localeCompare(right.design.id));
}
