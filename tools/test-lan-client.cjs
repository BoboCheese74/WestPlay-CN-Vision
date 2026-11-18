// Lightweight WebUI behavior checks. No browser automation or load tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../crates/host/src/lan.html'), 'utf8');
const body = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(body, 'HTML must contain a client script');

function makeClient(sourceWidth, sourceHeight, box) {
  const handlers = {};
  let captured = null;
  const viewer = {
    getBoundingClientRect: () => box,
    setPointerCapture: id => captured = id,
    hasPointerCapture: id => captured === id,
    releasePointerCapture: id => { if (captured === id) captured = null; },
    addEventListener: (type, callback) => { handlers[type] = callback; },
  };
  const mirror = { src: '' };
  const status = { textContent: '', hidden: false };
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; Socket.latest = this; }
    send(value) { this.sent.push(JSON.parse(value)); }
  }
  const context = {
    document: {
      getElementById: id => ({viewer, mirror, status})[id],
      addEventListener: () => {},
    },
    window: {addEventListener: () => {}},
    location: {host:'192.168.1.50:8765', search:'?token=123456'},
    performance: {now: (() => {let t = 0; return () => t += 18;})()},
    URLSearchParams,
    WebSocket: Socket,
    setTimeout: () => {},
    setInterval: () => {},
  };
  const script = body.replace('__SOURCE_WIDTH__', String(sourceWidth)).replace('__SOURCE_HEIGHT__', String(sourceHeight));
  vm.runInNewContext(script + '\nglobalThis.check = {contentRect, coordinates};', context);
  return {handlers, viewer, mirror, status, check:context.check, socket:Socket.latest};
}
function near(a,b) { assert.ok(Math.abs(a-b) < 0.00001, `${a} != ${b}`); }
function point(x,y,id=7) {return {clientX:x,clientY:y,pointerId:id,button:0,preventDefault:()=>{}};}

let client = makeClient(1280,720,{left:0, top:0, width:1600,height:900});
let c = client.check.coordinates(point(800,450));
near(c.x,.5); near(c.y,.5);
client.handlers.pointerdown(point(800,450));
client.handlers.pointermove(point(960,540));
client.handlers.pointerup(point(960,540));
assert.deepEqual(client.socket.sent.map(e=>e.type), ['down','move','up']);
near(client.socket.sent[1].x,.6); near(client.socket.sent[1].y,.6);

client = makeClient(1280,720,{left:0,top:0,width:400,height:900});
client.handlers.pointerdown(point(200,20));
assert.equal(client.socket.sent.length,0,'do not click in portrait black bar');
const portraitRect = client.check.contentRect();
near(portraitRect.top,337.5); near(portraitRect.height,225);
const portraitCenter = client.check.coordinates(point(200,450));
near(portraitCenter.x,.5); near(portraitCenter.y,.5);

client = makeClient(1024,768,{left:0,top:0,width:1600,height:900});
let rect = client.check.contentRect();
near(rect.left,200); near(rect.width,1200); near(rect.height,900);
client.handlers.pointerdown(point(200,450));
near(client.socket.sent[0].x,0);near(client.socket.sent[0].y,.5);
client.handlers.pointercancel(point(200,450));
assert.equal(client.socket.sent[1].type,'cancel');
assert.ok(client.mirror.src.includes('/stream?token=123456'));
assert.ok(client.socket.url.includes('/ws?token=123456'));
console.log('PASS: WebUI syntax, landscape, portrait bars, 4:3 letterbox, one-finger drag/cancel, pairing URLs');
