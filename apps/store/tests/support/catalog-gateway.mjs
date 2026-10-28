// Deterministic SDK-valid public fixtures; never reaches the production backend.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const read = name => JSON.parse(readFileSync(new URL(`../fixtures/catalog-${name}.json`, import.meta.url)));
const bootstrap = read('bootstrap'), products = read('products'), detail = read('detail');
const cards = [...products.data.page, ...Array.from({length: 28}, (_, i) => ({ ...products.data.page[0], id: `fixture-chair-${i}`, slug: `fixture-chair-${i}`, name: `Z Chair ${String(i).padStart(2, '0')}` }))];
let requests = [], fail = false, wrongScope = false, metal = false;
const metalCollections = [
 { ...bootstrap.data.page[0], name: 'Architecture', description: 'Original city, courtyard and landmark-inspired compositions for travel lovers and architectural interiors.' },
 { ...bootstrap.data.page[1], name: 'Ninja Blades', description: 'Naruto Shippuden-inspired ninja blade concepts in full-scale replica proportions.' },
];
const metalCards = [
 { ...cards[0], id: 'fixture-sydney', name: 'Sydney Opera House Metal Wall Art', slug: 'sydney-opera-house', collection: 'Architecture', material: 'metal' },
 ...Array.from({ length: 26 }, (_, i) => ({ ...cards[0], id: `fixture-blade-${i}`, name: `Ninja Blade ${String(i).padStart(2, '0')}`, slug: `ninja-blade-${i}`, collection: 'Ninja Blades', material: 'metal' })),
];
const jpeg = readFileSync(new URL('../../public/images/hero-640.webp', import.meta.url));
createServer((req,res) => {
 const url = new URL(req.url, 'http://127.0.0.1:4319');
 const json = (body,status=200) => { res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store','X-Commerce-Cache':'DISABLED','X-Commerce-Environment':'fixture'}); res.end(JSON.stringify(body)); };
 if (url.pathname === '/control') {
  if (url.searchParams.has('catalog')) metal = url.searchParams.get('catalog') === 'metal';
  if (url.searchParams.has('fail')) fail = url.searchParams.get('fail') === '1';
  if (url.searchParams.has('scope')) wrongScope = url.searchParams.get('scope') === 'wrong';
  if (url.searchParams.has('reset')) requests = [];
  return json({requests});
 }
 requests.push({path:url.pathname, query:Object.fromEntries(url.searchParams)});
 const error = (code,status) => json({status:'error',version:1,code,message:'Fixture error'},status);
 if (fail) return error('ORIGIN_UNAVAILABLE',503);
 if (url.pathname.includes('/media/')) { res.writeHead(200, {'Content-Type':'image/webp','Cache-Control':'public, max-age=31536000, immutable'}); return res.end(jpeg); }
 const success = value => json({...structuredClone(value),generatedAt:Date.now()});
 if (url.pathname.endsWith('/bootstrap')) {
  const b = structuredClone(bootstrap); if (metal) b.data.page = metalCollections; if (wrongScope) b.data.shop.businessId='wrong-business'; return success(b);
 }
 if (url.pathname.endsWith('/collections')) return success({...bootstrap,data:{kind:'collections',page:metal ? metalCollections : bootstrap.data.page,cursor:null}});
 if (url.pathname.endsWith('/products')) {
  const p=url.searchParams, q=(p.get('search')??'').toLowerCase();
  if (q === 'broad') return error('INVALID_REQUEST',400);
  const limit=Number(p.get('limit')??24), scope=JSON.stringify([...p].filter(([k])=>k!=='cursor').sort());
  let offset=0;
  if(p.has('cursor')) {
   try { const c=JSON.parse(Buffer.from(p.get('cursor'),'base64url')); if(c.scope!==scope) throw Error(); offset=c.offset; }
   catch { return error('RESTART_PAGINATION',409); }
  }
  let found=(metal ? metalCards : cards).filter(c=>(!p.get('collection')||c.collection===p.get('collection'))&&(!p.get('material')||c.material===p.get('material'))&&(!q||`${c.name} ${c.collection} ${c.material}`.toLowerCase().split(/\s+/).some(t=>t.startsWith(q))));
  found.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  return success({...products,data:{kind:'products',page:found.slice(offset,offset+limit),cursor:offset+limit<found.length?Buffer.from(JSON.stringify({scope,offset:offset+limit})).toString('base64url'):null}});
 }
 if(metal && url.pathname.endsWith('/products/sydney-opera-house')) {
  const d = structuredClone(detail);
  Object.assign(d.data.product, metalCards[0]);
  d.data.product.related = [];
  return success(d);
 }
 if(url.pathname.endsWith('/products/arm')) return success(detail);
 return error('NOT_FOUND',404);
}).listen(4319,'127.0.0.1',()=>console.log('Catalog fixture gateway on 4319'));
