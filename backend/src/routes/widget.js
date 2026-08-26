const express = require('express');
const path = require('path');
const supabaseAdmin = require('../lib/supabase');

const router = express.Router();

/**
 * Resolve an org from a custom domain (Host header).
 * Pro users point chat.theirsite.com CNAME → our backend; when the request
 * arrives with their domain as Host, we serve their widget/bot page.
 */
async function resolveOrgByDomain(host) {
  if (!host) return null;
  const domain = host.split(':')[0].toLowerCase();
  if (/localhost|127\.0\.0\.1|onrender\.com|chitratech/i.test(domain)) return null; // skip platform hosts

  const { data } = await supabaseAdmin
    .from('settings')
    .select('organization_id')
    .eq('custom_domain', domain)
    .maybeSingle();
  return data?.organization_id || null;
}

/**
 * GET /widget.js?org=<orgId>
 * Serves the embeddable chat widget loader script.
 * Usage on customer site:
 *   <script src="https://api.chitra.ai/widget.js?org=ORG_ID" defer></script>
 */
router.get('/widget.js', async (req, res) => {
  // Custom domain: serve the owner's widget when Host matches their domain
  const orgId = req.query.org || (await resolveOrgByDomain(req.get('host')));
  if (!orgId) return res.status(400).send('// Missing org parameter');

  // Verify org exists + load branding settings
  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('id')
    .eq('id', orgId)
    .single();
  if (!org) return res.status(404).send('// Invalid org');

  const { data: settings } = await supabaseAdmin
    .from('settings')
    .select('brand_color, bot_name, welcome_message, white_label')
    .eq('organization_id', orgId)
    .maybeSingle();

  const brandColor = /^#[0-9a-fA-F]{6}$/.test(settings?.brand_color || '') ? settings.brand_color : '#059669';
  const botName = (settings?.bot_name || 'Chitra').replace(/['"\\]/g, '');
  const welcome = (settings?.welcome_message || 'Hi! How can I help you today?').replace(/['"\\]/g, '');
  const showBranding = !settings?.white_label;

  const backendUrl = process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get('host')}`;

  res.type('application/javascript');
  res.send(`(function(){
  if (window.__chitraWidgetLoaded) return;
  window.__chitraWidgetLoaded = true;
  var ORG_ID = ${JSON.stringify(orgId)};
  var API = ${JSON.stringify(backendUrl)};
  var BRAND = ${JSON.stringify(brandColor)};
  var BOT_NAME = ${JSON.stringify(botName)};
  var WELCOME = ${JSON.stringify(welcome)};

  var css = document.createElement('style');
  css.textContent = [
    '#chitra-launcher{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;',
    'background:'+BRAND+';color:#fff;border:none;font-size:24px;cursor:pointer;z-index:999999;',
    'box-shadow:0 4px 16px rgba(0,0,0,.25);transition:transform .15s}',
    '#chitra-launcher:hover{transform:scale(1.08)}',
    '#chitra-panel{position:fixed;bottom:88px;right:20px;width:360px;max-width:calc(100vw - 32px);height:520px;',
    'max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.2);',
    'z-index:999999;display:none;flex-direction:column;overflow:hidden;font-family:system-ui,-apple-system,sans-serif}',
    '#chitra-panel.open{display:flex}',
    '.chitra-header{background:'+BRAND+';color:#fff;padding:14px 16px;font-weight:600;font-size:15px}',
    '#chitra-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f9fafb}',
    '.chitra-msg{max-width:82%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}',
    '.chitra-msg.bot{background:#fff;border:1px solid #e5e7eb;align-self:flex-start;border-bottom-left-radius:4px}',
    '.chitra-msg.user{background:'+BRAND+';color:#fff;align-self:flex-end;border-bottom-right-radius:4px}',
    '#chitra-form{display:flex;border-top:1px solid #e5e7eb;background:#fff}',
    '#chitra-input{flex:1;border:none;padding:12px;font-size:14px;outline:none;font-family:inherit}',
    '#chitra-send{border:none;background:'+BRAND+';color:#fff;padding:0 18px;font-size:14px;cursor:pointer;font-weight:600}'
  ].join('');
  document.head.appendChild(css);

  var panel = document.createElement('div');
  panel.id = 'chitra-panel';
  panel.innerHTML =
    '<div class="chitra-header">'+BOT_NAME+'</div>' +
    '<div id="chitra-msgs"></div>' +
    '<form id="chitra-form"><input id="chitra-input" placeholder="Type a message..." autocomplete="off"/>' +
    '<button id="chitra-send" type="submit">Send</button></form>' +
    ${showBranding ? "'<div style=\\\"padding:6px;text-align:center;font-size:10px;color:#9ca3af;background:#fff\\\">Powered by <a href=\\\"https://chitratech.com.np\\\" target=\\\"_blank\\\" style=\\\"color:inherit;font-weight:600\\\">Chitra AI</a></div>'" : "''"};
  document.body.appendChild(panel);

  var launcher = document.createElement('button');
  launcher.id = 'chitra-launcher';
  launcher.style.padding = '0';
  launcher.style.overflow = 'hidden';
  launcher.style.background = '#fff';
  launcher.innerHTML = '<img src="'+API+'/logo.webp" alt="Chat" style="width:100%;height:100%;object-fit:cover"/>';
  launcher.onclick = function(){ panel.classList.toggle('open'); };
  document.body.appendChild(launcher);

  var msgs = document.getElementById('chitra-msgs');
  var sessionId = localStorage.getItem('chitra_session') ||
    (localStorage.setItem('chitra_session','s_'+Math.random().toString(36).slice(2)+Date.now()),
     localStorage.getItem('chitra_session'));

  function addMsg(text, who){
    var d=document.createElement('div');
    d.className='chitra-msg '+who;
    if(who==='bot'){ renderMd(d, text); } else { d.textContent=text; }
    msgs.appendChild(d);
    msgs.scrollTop=msgs.scrollHeight;
  }

  /* Mini markdown renderer: tables, bold, italic, code, links, lists, headings */
  function esc(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function inline(s){
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g,'$1<em>$2</em>')
      .replace(new RegExp('\x60([^\x60]+)\x60','g'),'<code style="background:#f3f4f6;padding:1px 4px;border-radius:3px;font-size:12px">$1</code>')
      .replace(new RegExp('\\\\[([^\\\\]]+)\\\\]\\\\(([^)]+)\\\\)','g'),'<a href="$2" target="_blank" rel="noopener" style="color:'+BRAND+';text-decoration:underline">$1</a>');
  }
  function renderMd(container, text){
    var lines=String(text).split('\\n');
    var html='', list=[], ordered=false, table=null;

    function flushList(){
      if(!list.length) return;
      var items=list.map(function(it){return '<li style="margin:2px 0">'+inline(it)+'</li>';}).join('');
      html += ordered
        ? '<ol style="margin:4px 0;padding-left:20px">'+items+'</ol>'
        : '<ul style="margin:4px 0;padding-left:20px">'+items+'</ul>';
      list=[];
    }
    function flushTable(){
      if(!table) return;
      var head='<tr>'+table.header.map(function(c){return '<th style="text-align:left;padding:5px 8px;background:#f9fafb;font-weight:600">'+inline(c)+'</th>';}).join('')+'</tr>';
      var rows=table.rows.map(function(r){
        return '<tr>'+r.map(function(c){return '<td style="padding:5px 8px;border-top:1px solid #f0f0f0;vertical-align:top">'+inline(c)+'</td>';}).join('')+'</tr>';
      }).join('');
      html+='<div style="overflow-x:auto;margin:6px 0"><table style="border-collapse:collapse;width:100%;font-size:12px;border:1px solid #eee;border-radius:6px">'+head+rows+'</table></div>';
      table=null;
    }

    for(var i=0;i<lines.length;i++){
      var line=lines[i];
      var tr=line.match(/^\\s*\\|(.+)\\|\\s*$/);
      if(tr){
        var cells=tr[1].split('|').map(function(c){return c.trim();});
        if(cells.every(function(c){return /^:?-{2,}:?$/.test(c);})) continue;
        if(!table) table={header:cells,rows:[]}; else table.rows.push(cells);
        continue;
      }
      flushTable();

      var h=line.match(/^(#{1,6})\\s+(.*)/);
      var b=line.match(/^\\s*[-•*]\\s+(.*)/);
      var n=line.match(/^\\s*(\\d+)[.)]\\s+(.*)/);

      if(h){
        flushList();
        html+='<p style="margin:6px 0 2px;font-weight:600">'+inline(h[2])+'</p>';
      } else if(b||n){
        var ord=!!n;
        if(list.length && ordered!==ord) flushList();
        ordered=ord;
        list.push(n?n[2]:b[1]);
      } else if(line.trim()){
        flushList();
        html+='<p style="margin:3px 0">'+inline(line)+'</p>';
      }
    }
    flushList();
    flushTable();
    container.innerHTML=html || esc(text);
  }

  addMsg(WELCOME,'bot');

  document.getElementById('chitra-form').onsubmit=function(e){
    e.preventDefault();
    var input=document.getElementById('chitra-input');
    var text=input.value.trim();
    if(!text) return;
    input.value='';
    addMsg(text,'user');
    var typing=document.createElement('div');
    typing.className='chitra-msg bot';
    typing.textContent='…';
    msgs.appendChild(typing);
    msgs.scrollTop=msgs.scrollHeight;

    fetch(API+'/api/chat',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({orgId:ORG_ID,sessionId:sessionId,message:text,cfTurnstile:window.__chitraTurnstileToken||''})
    }).then(function(r){return r.json();}).then(function(data){
      typing.remove();
      addMsg(data.reply||data.error||'Sorry, something went wrong.','bot');
    }).catch(function(){
      typing.remove();
      addMsg('Connection error. Please try again.','bot');
    });
  };
})();`);
});

/**
 * GET /bot/:orgId — standalone hosted chat page (for QR codes / direct links).
 * Also resolves custom domains: a Pro user's domain root serves their bot page.
 */
router.get(['/bot/:orgId', '/'], async (req, res) => {
  // Custom domain: Host header wins when no explicit orgId
  const orgId = req.params.orgId || (await resolveOrgByDomain(req.get('host')));
  if (!orgId) return res.status(404).send('Not found');

  const { data: org } = await supabaseAdmin
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .single();

  if (!org) return res.status(404).send('Business not found');

  const backendUrl = process.env.PUBLIC_BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Chat — ${org.name}</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#f3f4f6;display:flex;justify-content:center}
#chat{width:100%;max-width:480px;height:100vh;display:flex;flex-direction:column;background:#fff}
#msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:80%;padding:10px 14px;border-radius:14px;font-size:15px;line-height:1.5;white-space:pre-wrap}
.bot{background:#f3f4f6;align-self:flex-start}.user{background:#6366f1;color:#fff;align-self:flex-end}
form{display:flex;border-top:1px solid #e5e7eb}input{flex:1;border:none;padding:16px;font-size:15px;outline:none}
button{border:none;background:#6366f1;color:#fff;padding:0 22px;font-size:15px;font-weight:600;cursor:pointer}
h1{font-size:17px;text-align:center;padding:14px;margin:0;color:#111;border-bottom:1px solid #eee}
</style></head><body><div id="chat">
<h1>💬 ${org.name}</h1><div id="msgs"></div>
<form><input id="in" placeholder="Type a message..." autocomplete="off"/><button>Send</button></form></div>
<script>
var msgs=document.getElementById('msgs'),sid='s_'+Math.random().toString(36).slice(2)+Date.now();
function add(t,w){var d=document.createElement('div');d.className='msg '+w;d.textContent=t;msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;}
add('Hi! How can I help you today?','bot');
document.querySelector('form').onsubmit=function(e){e.preventDefault();
var i=document.getElementById('in'),t=i.value.trim();if(!t)return;i.value='';add(t,'user');
fetch('${backendUrl}/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({orgId:'${orgId}',sessionId:sid,message:t})})
.then(function(r){return r.json()}).then(function(d){add(d.reply||d.error||'Error','bot')});
};
</script></body></html>`);
});

module.exports = router;
