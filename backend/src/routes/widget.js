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
  const botName = (settings?.bot_name || 'Chitra').trim().replace(/['"\\]/g, '').trim();
  const welcome = (settings?.welcome_message || 'Hi! How can I help you today?').trim().replace(/['"\\]/g, '').trim();
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
    '#chitra-panel{position:fixed;bottom:88px;right:20px;width:360px;max-width:calc(100vw - 32px);height:520px;overscroll-behavior:contain;',
    'max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.2);',
    'z-index:999999;display:none;flex-direction:column;overflow:hidden;font-family:system-ui,-apple-system,sans-serif}',
    '#chitra-panel.open{display:flex}',
    '.chitra-header{background:'+BRAND+';color:#fff;padding:12px 14px;font-weight:600;font-size:15px;display:flex;justify-content:space-between;align-items:center}',
    '#chitra-close{background:transparent;border:none;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0 4px;font-weight:400}',
    '#chitra-close:hover{opacity:.75}',
    '#chitra-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f9fafb;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}',
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
    '<div class="chitra-header"><span>'+BOT_NAME+'</span><button id="chitra-close" type="button" aria-label="Close chat">&times;</button></div>' +
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

  // Scroll isolation: when the cursor is over the chat panel, the wheel
  // scrolls the conversation — never the host website behind it.
  panel.addEventListener('wheel', function(e){
    e.preventDefault();
    e.stopPropagation();
    msgs.scrollTop += e.deltaY;
  }, { passive: false });

  // Close button: hides the chat panel (the launcher button reopens it)
  var closeBtn = document.getElementById('chitra-close');
  if (closeBtn) closeBtn.onclick = function(){ panel.classList.remove('open'); };

  function addMsg(text, who){
    var d=document.createElement('div');
    d.className='chitra-msg '+who;
    if(who==='bot'){ renderMd(d, text); } else { d.textContent=text; }
    msgs.appendChild(d);
    msgs.scrollTop=msgs.scrollHeight;
  }

    /* Markdown renderer v2 — headings, bold/italic, inline code, code blocks,
     links (md + <autolinks> + bare URLs), lists, tables, blockquotes, hr */
  function esc(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  var _stash = [];
  function _stashPut(html){ _stash.push(html); return '\\x01' + (_stash.length - 1) + '\\x01'; }
  function inline(s){
    var out = esc(s);
    // [text](url)
    out = out.replace(/\\[([^\\]\\n]+)\\]\\((https?:[^)\\s]+)\\)/g, function(m,t,u){
      return _stashPut('<a href="'+u+'" target="_blank" rel="noopener" style="color:'+BRAND+';text-decoration:underline">'+t+'</a>');
    });
    // <https://...> autolinks
    out = out.replace(/&lt;(https?:\\/\\/[^&\\s]+)&gt;/g, function(m,u){
      return _stashPut('<a href="'+u+'" target="_blank" rel="noopener" style="color:'+BRAND+';text-decoration:underline">'+u+'</a>');
    });
    // bare URLs
    out = out.replace(/(^|[\\s>])(https?:\\/\\/[^\\s&<]+)/g, function(m,p,u){
      return p + _stashPut('<a href="'+u+'" target="_blank" rel="noopener" style="color:'+BRAND+';text-decoration:underline">'+u+'</a>');
    });
    // bold / italic / inline code
    out = out.replace(/\\*\\*([^*\\n]+)\\*\\*/g,'<strong>$1</strong>');
    out = out.replace(/(^|[^*\\w])\\*([^*\\n]+)\\*/g,'$1<em>$2</em>');
    out = out.replace(new RegExp('\\\\x60([^\\\\x60\\\\n]+)\\\\x60','g'),'<code style="background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">$1</code>');
    // restore stashed links (after formatting, so nothing double-processes them)
    out = out.replace(/\\x01(\\d+)\\x01/g, function(m,i){ return _stash[+i] || ''; });
    return out;
  }
  function renderMd(container, text){
    _stash.length = 0;
    var lines = String(text).split('\\n');
    var html = '', list = [], ordered = false, table = null, inCode = false, codeLines = [];

    function flushList(){
      if(!list.length) return;
      var tag = ordered ? 'ol' : 'ul';
      var items = list.map(function(it){ return '<li style="margin:3px 0">'+inline(it)+'</li>'; }).join('');
      html += '<'+tag+' style="margin:6px 0;padding-left:22px">'+items+'</'+tag+'>';
      list = [];
    }
    function flushTable(){
      if(!table) return;
      var head = '<tr>'+table.header.map(function(c){
        return '<th style="text-align:left;padding:7px 10px;background:'+BRAND+'14;color:#111827;font-weight:700;font-size:12px;border-bottom:2px solid '+BRAND+'40">'+inline(c)+'</th>';
      }).join('')+'</tr>';
      var rows = table.rows.map(function(r,ri){
        return '<tr style="background:'+(ri%2 ? '#f9fafb' : '#fff')+'">'+r.map(function(c){
          return '<td style="padding:6px 10px;border-top:1px solid #e5e7eb;vertical-align:top">'+inline(c)+'</td>';
        }).join('')+'</tr>';
      }).join('');
      html += '<div style="overflow-x:auto;margin:8px 0;border:1px solid #e5e7eb;border-radius:8px"><table style="border-collapse:collapse;width:100%;font-size:12.5px">'+head+rows+'</table></div>';
      table = null;
    }
    function flushAll(){ flushList(); flushTable(); }
    function p(inner, extra){ html += '<p style="margin:4px 0;'+(extra||'')+'">'+inner+'</p>'; }

    for(var i=0;i<lines.length;i++){
      var line = lines[i];

      // fenced code blocks
      if(/^\\s*\\x60{3}/.test(line)){
        if(inCode){
          html += '<pre style="background:#111827;color:#f9fafb;padding:10px 12px;border-radius:8px;overflow-x:auto;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:8px 0">'+esc(codeLines.join('\\n'))+'</pre>';
          inCode=false; codeLines=[];
        } else {
          flushAll();
          inCode=true;
        }
        continue;
      }
      if(inCode){ codeLines.push(line); continue; }

      // tables — a header row only counts if the next line is a separator
      var tr = line.match(/^\\s*\\|(.+)\\|\\s*$/);
      if(tr){
        var cells = tr[1].split('|').map(function(c){ return c.trim(); });
        var isSep = cells.every(function(c){ return /^:?-{2,}:?$/.test(c); });
        if(isSep) continue;
        if(!table){
          var nxt = (lines[i+1] || '').match(/^\\s*\\|(.+)\\|\\s*$/);
          var nxtSep = !!(nxt && nxt[1].split('|').every(function(c){ return /^:?-{2,}:?$/.test(c.trim()); }));
          if(!nxtSep){ flushAll(); p(inline(line.trim())); continue; }
          table = { header: cells, rows: [] };
        } else table.rows.push(cells);
        continue;
      }
      flushTable();

      if(/^\\s*(---+|\\*\\*\\*+)\\s*$/.test(line)){ flushAll(); html += '<hr style="border:none;border-top:1px solid #e5e7eb;margin:8px 0"/>'; continue; }

      var h = line.match(/^(#{1,6})\\s+(.*)/);
      var b = line.match(/^\\s*[-\\u2022*]\\s+(.+)/);
      var n = line.match(/^\\s*(\\d+)[.)]\\s+(.+)/);
      var bq = line.match(/^\\s*>\\s?(.*)/);

      if(h){
        flushAll();
        var lvl = h[1].length;
        var size = lvl===1?'16px':lvl===2?'15px':lvl===3?'14px':'13px';
        p(inline(h[2]), 'font-weight:700;font-size:'+size+';color:#111827');
      } else if(b || n){
        var ord = !!n;
        if(list.length && ordered !== ord) flushList();
        ordered = ord;
        list.push(n ? n[2] : b[1]);
      } else if(bq){
        flushAll();
        html += '<p style="margin:4px 0;padding:4px 10px;border-left:3px solid '+BRAND+';background:'+BRAND+'0d;color:#374151;font-size:13px">'+inline(bq[1])+'</p>';
      } else if(line.trim()){
        flushList();
        p(inline(line));
      }
    }
    if(inCode && codeLines.length){
      html += '<pre style="background:#111827;color:#f9fafb;padding:10px 12px;border-radius:8px;overflow-x:auto;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">'+esc(codeLines.join('\\n'))+'</pre>';
    }
    flushAll();
    container.innerHTML = html || esc(text);
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
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1,interactive-widget=resizes-content"/>
<title>Chat — ${org.name}</title>
<style>
html,body{height:100%}
body{margin:0;font-family:system-ui,sans-serif;background:#f3f4f6;display:flex;justify-content:center;overflow:hidden}
#chat{width:100%;max-width:480px;height:100vh;height:100dvh;display:flex;flex-direction:column;background:#fff}
#msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.msg{max-width:85%;padding:10px 14px;border-radius:14px;font-size:15px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word}
.bot{background:#f3f4f6;align-self:flex-start}.user{background:#6366f1;color:#fff;align-self:flex-end}
.msg table{max-width:100%}
.msg pre{max-width:100%}
form{display:flex;border-top:1px solid #e5e7eb;background:#fff;padding-bottom:env(safe-area-inset-bottom)}
input{flex:1;min-width:0;border:none;padding:16px;font-size:16px;outline:none}
button{border:none;background:#6366f1;color:#fff;padding:0 22px;font-size:15px;font-weight:600;cursor:pointer}
h1{font-size:17px;text-align:center;padding:14px;margin:0;color:#111;border-bottom:1px solid #eee}
</style></head><body><div id="chat">
<h1>💬 ${org.name}</h1><div id="msgs"></div>
<form><input id="in" placeholder="Type a message..." autocomplete="off" enterkeyhint="send"/><button>Send</button></form></div>
<script>
var msgs=document.getElementById('msgs'),sid='s_'+Math.random().toString(36).slice(2)+Date.now();
var BRAND = '#6366f1';
  /* Markdown renderer v2 — headings, bold/italic, inline code, code blocks,
     links (md + <autolinks> + bare URLs), lists, tables, blockquotes, hr */
  function esc(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  var _stash = [];
  function _stashPut(html){ _stash.push(html); return '\\x01' + (_stash.length - 1) + '\\x01'; }
  function inline(s){
    var out = esc(s);
    // [text](url)
    out = out.replace(/\\[([^\\]\\n]+)\\]\\((https?:[^)\\s]+)\\)/g, function(m,t,u){
      return _stashPut('<a href="'+u+'" target="_blank" rel="noopener" style="color:'+BRAND+';text-decoration:underline">'+t+'</a>');
    });
    // <https://...> autolinks
    out = out.replace(/&lt;(https?:\\/\\/[^&\\s]+)&gt;/g, function(m,u){
      return _stashPut('<a href="'+u+'" target="_blank" rel="noopener" style="color:'+BRAND+';text-decoration:underline">'+u+'</a>');
    });
    // bare URLs
    out = out.replace(/(^|[\\s>])(https?:\\/\\/[^\\s&<]+)/g, function(m,p,u){
      return p + _stashPut('<a href="'+u+'" target="_blank" rel="noopener" style="color:'+BRAND+';text-decoration:underline">'+u+'</a>');
    });
    // bold / italic / inline code
    out = out.replace(/\\*\\*([^*\\n]+)\\*\\*/g,'<strong>$1</strong>');
    out = out.replace(/(^|[^*\\w])\\*([^*\\n]+)\\*/g,'$1<em>$2</em>');
    out = out.replace(new RegExp('\\\\x60([^\\\\x60\\\\n]+)\\\\x60','g'),'<code style="background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">$1</code>');
    // restore stashed links (after formatting, so nothing double-processes them)
    out = out.replace(/\\x01(\\d+)\\x01/g, function(m,i){ return _stash[+i] || ''; });
    return out;
  }
  function renderMd(container, text){
    _stash.length = 0;
    var lines = String(text).split('\\n');
    var html = '', list = [], ordered = false, table = null, inCode = false, codeLines = [];

    function flushList(){
      if(!list.length) return;
      var tag = ordered ? 'ol' : 'ul';
      var items = list.map(function(it){ return '<li style="margin:3px 0">'+inline(it)+'</li>'; }).join('');
      html += '<'+tag+' style="margin:6px 0;padding-left:22px">'+items+'</'+tag+'>';
      list = [];
    }
    function flushTable(){
      if(!table) return;
      var head = '<tr>'+table.header.map(function(c){
        return '<th style="text-align:left;padding:7px 10px;background:'+BRAND+'14;color:#111827;font-weight:700;font-size:12px;border-bottom:2px solid '+BRAND+'40">'+inline(c)+'</th>';
      }).join('')+'</tr>';
      var rows = table.rows.map(function(r,ri){
        return '<tr style="background:'+(ri%2 ? '#f9fafb' : '#fff')+'">'+r.map(function(c){
          return '<td style="padding:6px 10px;border-top:1px solid #e5e7eb;vertical-align:top">'+inline(c)+'</td>';
        }).join('')+'</tr>';
      }).join('');
      html += '<div style="overflow-x:auto;margin:8px 0;border:1px solid #e5e7eb;border-radius:8px"><table style="border-collapse:collapse;width:100%;font-size:12.5px">'+head+rows+'</table></div>';
      table = null;
    }
    function flushAll(){ flushList(); flushTable(); }
    function p(inner, extra){ html += '<p style="margin:4px 0;'+(extra||'')+'">'+inner+'</p>'; }

    for(var i=0;i<lines.length;i++){
      var line = lines[i];

      // fenced code blocks
      if(/^\\s*\\x60{3}/.test(line)){
        if(inCode){
          html += '<pre style="background:#111827;color:#f9fafb;padding:10px 12px;border-radius:8px;overflow-x:auto;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:8px 0">'+esc(codeLines.join('\\n'))+'</pre>';
          inCode=false; codeLines=[];
        } else {
          flushAll();
          inCode=true;
        }
        continue;
      }
      if(inCode){ codeLines.push(line); continue; }

      // tables — a header row only counts if the next line is a separator
      var tr = line.match(/^\\s*\\|(.+)\\|\\s*$/);
      if(tr){
        var cells = tr[1].split('|').map(function(c){ return c.trim(); });
        var isSep = cells.every(function(c){ return /^:?-{2,}:?$/.test(c); });
        if(isSep) continue;
        if(!table){
          var nxt = (lines[i+1] || '').match(/^\\s*\\|(.+)\\|\\s*$/);
          var nxtSep = !!(nxt && nxt[1].split('|').every(function(c){ return /^:?-{2,}:?$/.test(c.trim()); }));
          if(!nxtSep){ flushAll(); p(inline(line.trim())); continue; }
          table = { header: cells, rows: [] };
        } else table.rows.push(cells);
        continue;
      }
      flushTable();

      if(/^\\s*(---+|\\*\\*\\*+)\\s*$/.test(line)){ flushAll(); html += '<hr style="border:none;border-top:1px solid #e5e7eb;margin:8px 0"/>'; continue; }

      var h = line.match(/^(#{1,6})\\s+(.*)/);
      var b = line.match(/^\\s*[-\\u2022*]\\s+(.+)/);
      var n = line.match(/^\\s*(\\d+)[.)]\\s+(.+)/);
      var bq = line.match(/^\\s*>\\s?(.*)/);

      if(h){
        flushAll();
        var lvl = h[1].length;
        var size = lvl===1?'16px':lvl===2?'15px':lvl===3?'14px':'13px';
        p(inline(h[2]), 'font-weight:700;font-size:'+size+';color:#111827');
      } else if(b || n){
        var ord = !!n;
        if(list.length && ordered !== ord) flushList();
        ordered = ord;
        list.push(n ? n[2] : b[1]);
      } else if(bq){
        flushAll();
        html += '<p style="margin:4px 0;padding:4px 10px;border-left:3px solid '+BRAND+';background:'+BRAND+'0d;color:#374151;font-size:13px">'+inline(bq[1])+'</p>';
      } else if(line.trim()){
        flushList();
        p(inline(line));
      }
    }
    if(inCode && codeLines.length){
      html += '<pre style="background:#111827;color:#f9fafb;padding:10px 12px;border-radius:8px;overflow-x:auto;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">'+esc(codeLines.join('\\n'))+'</pre>';
    }
    flushAll();
    container.innerHTML = html || esc(text);
  }

function add(t,w){var d=document.createElement('div');d.className='msg '+w;if(w==='bot'){renderMd(d,t);}else{d.textContent=t;}msgs.appendChild(d);msgs.scrollTop=msgs.scrollHeight;}
add('Hi! How can I help you today?','bot');
// Keep the input visible & conversation pinned when the mobile keyboard opens
var inEl=document.getElementById('in');
inEl.addEventListener('focus',function(){setTimeout(function(){msgs.scrollTop=msgs.scrollHeight;},300);});
inEl.addEventListener('input',function(){msgs.scrollTop=msgs.scrollHeight;});
document.querySelector('form').onsubmit=function(e){e.preventDefault();
var i=document.getElementById('in'),t=i.value.trim();if(!t)return;i.value='';add(t,'user');
fetch('${backendUrl}/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({orgId:'${orgId}',sessionId:sid,message:t})})
.then(function(r){return r.json()}).then(function(d){add(d.reply||d.error||'Error','bot')}).catch(function(){add('Connection error. Please try again.','bot')});
};
</script></body></html>`);
});

module.exports = router;
