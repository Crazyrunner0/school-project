import { readFile } from 'node:fs/promises';

// Node загружает браузерные ESM-файлы через data URL без package.json и сборки.
const root = new URL('../../', import.meta.url);
const toUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

export async function browserModuleUrls() {
  const geometryUrl = toUrl(await readFile(new URL('geometry.js', root)));
  const files = [
    'analyzer.js', 'plankAnalyzer.js', 'sidePlankAnalyzer.js', 'bicepCurlAnalyzer.js',
    'lungeAnalyzer.js', 'overheadPressAnalyzer.js', 'deadliftAnalyzer.js',
    'jumpingJacksAnalyzer.js', 'gluteBridgeAnalyzer.js', 'pullupAnalyzer.js'
  ];
  const analyzerUrls = {};
  for (const file of files) {
    const source = (await readFile(new URL(file, root), 'utf8'))
      .replace("'./geometry.js'", `'${geometryUrl}'`);
    analyzerUrls[file] = toUrl(source);
  }
  let factorySource = await readFile(new URL('exerciseFactory.js', root), 'utf8');
  for (const [file, url] of Object.entries(analyzerUrls)) {
    factorySource = factorySource.replace(`'./${file}'`, `'${url}'`);
  }
  return { geometryUrl, analyzerUrl: analyzerUrls['analyzer.js'], factoryUrl: toUrl(factorySource) };
}
