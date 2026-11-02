import { readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import { defaultBuyerGuide } from '../shared/buyer-guide.ts';
import sharp from 'sharp';
import { dirname } from 'node:path';
import { fixtureSvg } from '../shared/fixture-art.ts';
const dir = 'dist-preview';
const data = JSON.parse(await readFile('preview/catalog.json','utf8'));
data.settings.buyerGuide = defaultBuyerGuide;
data.settings.acceptingOrders = false;
data.settings.phone = '';
data.settings.phoneIsTest = true;
data.settings.telegramUsername = '';
data.settings.seller = '';
data.settings.documentStatus = 'DRAFT';
data.settings.documents = {privacy:'',reservation:'',shipping:'',returns:''};
data.settings.carriers = {EUROPOST:{enabled:true,terms:defaultBuyerGuide.shipping},BELPOST:{enabled:false,terms:''}};
await writeFile(dir+'/preview-data.json',JSON.stringify(data));
await cp('preview/adapter.js',dir+'/preview-api.js');
const art = {outerwear:['jacket','#b8794f'],trousers:['pants','#536b86'],knit:['jacket','#d7c5a9'],shirts:['shirt','#c5d3d9'],children:['jacket','#d2b6b5'],bags:['bag','#97715a'],accessories:['scarf','#a9b6a1'],dresses:['dress','#b4ad99']};
for (const item of data.items) for (const media of item.media) {
  const [shape,color] = art[item.category];
  const svg = Buffer.from(fixtureSvg(shape,color));
  for (const [width,url] of Object.entries(media.variants)) {
    await mkdir(dirname(dir+url),{recursive:true});
    await sharp(svg).resize({width:Number(width),withoutEnlargement:true}).webp({quality:84}).toFile(dir+url);
  }
}
let html = await readFile(dir+'/index.html','utf8');
html = html.replace(/<script id="telegram-sdk"[^>]*><\/script>/g,'').replace('<head>','<head><meta name="robots" content="noindex,nofollow"><script src="/preview-api.js"></script>');
await writeFile(dir+'/index.html',html);
