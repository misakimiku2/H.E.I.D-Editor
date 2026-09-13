//! 网页抓取第二层兜底：隐藏 WebView 渲染后取回渲染完成的 outerHTML。
//! 仅当静态抓取结果过薄（SPA 空壳 / 前端渲染站点）时由前端 renderFetch 调用；
//! 渲染窗口标签 heid-scraper 在 capabilities/scraper.json 里仅被授予
//! render_result 一条命令且面向 http(s) 远程 URL——页面最多能把 HTML 字符串
//! 送回来，触碰不到文件系统与其他命令。
//! 流程：run_on_main_thread 建隐藏窗口 → on_page_load(Finished) 注入 settle 脚本
//! （DOM 长度稳定 ~2.5s 或硬超时后，页面内经 __TAURI_INTERNALS__ 调 render_result
//! 回传）→ 主命令 recv_timeout 等结果 → 销毁窗口并返回。

use crate::http::validate_url;
use std::collections::HashMap;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::Manager;

/// 隐藏渲染窗口的固定标签（capability 仅对此标签授权）
const SCRAPER_LABEL: &str = "heid-scraper";
/// 渲染等待总超时：初始稳定 ~12s + 点击遍历 10s + 二次稳定 4s
/// + 播放遍历 ≤60s（逐条等文本，连续 8 条失败即早退）+ 三次稳定 ~3s + 余量
const RENDER_TIMEOUT: Duration = Duration::from_secs(100);
/// 回传 HTML 大小上限（16MB）
const MAX_HTML_BYTES: usize = 16 * 1024 * 1024;

/// 文档启动时注入的响应录制 + 全程静音脚本：包一层 fetch/XHR，把 JSON 响应
/// 暂存到 window.__HEID_NET__（ trackers 除外），供 SETTLE_JS 提取「点击播放
/// 才注入」的站点数据（如库街区语音台词）；同时以捕获阶段的 play 监听把
/// 所有媒体静音——抓取是无人值守的，不该出声。
const INIT_JS: &str = r#"(function () {
  if (window.__HEID_NET_INIT__) return;
  window.__HEID_NET_INIT__ = true;
  window.__HEID_NET__ = [];
  /* 静音一切媒体（播放事件不冒泡，但捕获阶段监听可命中） */
  var mute = function (e) { try { if (e && e.target && 'muted' in e.target) e.target.muted = true; } catch (err) {} };
  document.addEventListener('play', mute, true);
  document.addEventListener('playing', mute, true);
  var DENY = /datareceiver|sdklog|sentry|beacon|track|analytics|\/ip\b/i;
  var push = function (url, body) {
    try {
      url = String(url || '');
      if (!url || !body || body.length < 64 || DENY.test(url)) return;
      if (window.__HEID_NET__.length >= 24) return;
      window.__HEID_NET__.push({ url: url.slice(0, 300), body: String(body).slice(0, 12582912) });
    } catch (e) {}
  };
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      var p = origFetch.apply(this, arguments);
      try {
        p.then(function (res) {
          try { res.clone().text().then(function (t) { push(res.url, t); }).catch(function () {}); } catch (e) {}
        }).catch(function () {});
      } catch (e) {}
      return p;
    };
  }
  var XO = window.XMLHttpRequest;
  if (XO && XO.prototype) {
    var oOpen = XO.prototype.open, oSend = XO.prototype.send;
    XO.prototype.open = function (m, u) { this.__heidUrl = u; return oOpen.apply(this, arguments); };
    XO.prototype.send = function () {
      var xhr = this;
      xhr.addEventListener('load', function () {
        try {
          if (xhr.responseType === '' || xhr.responseType === 'text') push(xhr.__heidUrl, xhr.responseText);
        } catch (e) {}
      });
      return oSend.apply(this, arguments);
    };
  }
})()"#;

/// 页面内注入的稳定检测 + 懒加载展开脚本：
/// 1) DOM 长度连续 5×500ms 不变即视为初始渲染完成（24 次轮询硬上限）；
/// 2) 点击遍历短文本叶子元素，展开游戏 wiki 常见的「点击后才加载」的面板
///    （语音/技能/天赋等）。关键词命中者优先；误触 SPA 路由时用 history.back()
///    恢复后继续；每次点击后快照，最终取可见文本最长的一份回传；
/// 3) 录制响应中按「DOM 条目标题 → 同对象长文本」配对注入语音台词，命中则
///    跳过播放遍历；否则点击播放控件逐条收集。
const SETTLE_JS: &str = r#"(function () {
  if (window.__HEID_SETTLE__) return;
  window.__HEID_SETTLE__ = true;
  var startHref = location.href;
  var navFlag = false;
  var best = null;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var docLen = function () { return document.documentElement ? document.documentElement.outerHTML.length : 0; };
  var snapshot = function () {
    var text = document.body && document.body.innerText ? document.body.innerText : '';
    if (!best || text.length > best.text.length) {
      best = {
        text: text.slice(0, 1048576),
        html: document.documentElement ? document.documentElement.outerHTML.slice(0, 8388608) : ''
      };
    }
  };
  var stable = function (idleNeed, tickCap, wait) {
    return new Promise(function (done) {
      var i = 0, t = 0, lastLen = -1;
      var step = function () {
        t++;
        var len = docLen();
        if (len === lastLen) { i++; } else { i = 0; lastLen = len; }
        if (i >= idleNeed || t >= tickCap) { done(); return; }
        setTimeout(step, wait);
      };
      step();
    });
  };
  var clickThrough = function () {
    return new Promise(function (done) {
      var deadline = Date.now() + 10000;
      var KEY = /(语音|voice|技能|skill|天赋|talent|战斗|battle|档案|故事|story|资料|台词|audio)/i;
      var seen = {}, cands = [];
      try {
        var all = document.body ? document.body.querySelectorAll('*') : [];
        for (var k = 0; k < all.length; k++) {
          var el = all[k];
          if (el.childElementCount !== 0) continue;
          var tag = el.tagName;
          if (tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'LABEL') continue;
          if (tag === 'BUTTON' && el.getAttribute('type') === 'submit') continue;
          if (el.closest && el.closest('a, nav, header, footer')) continue;
          var t2 = (el.textContent || '').trim();
          if (t2.length < 2 || t2.length > 20) continue;
          if (!el.offsetParent) continue;
          if (seen[t2]) continue;
          seen[t2] = 1;
          cands.push({ el: el, t: t2, pri: KEY.test(t2) ? 0 : 1 });
        }
      } catch (e) {}
      cands.sort(function (a, b) { return a.pri - b.pri; });
      cands = cands.slice(0, 24);
      var idx = 0;
      var step = function () {
        if (idx >= cands.length || Date.now() > deadline) { done(); return; }
        try { cands[idx].el.click(); } catch (e) {}
        idx++;
        setTimeout(function () {
          if (navFlag || location.href !== startHref) {
            navFlag = false;
            try { history.back(); } catch (e) {}
            setTimeout(function () {
              if (location.href === startHref) { try { snapshot(); } catch (e) {} step(); }
                              else done();
            }, 700);
            return;
          }
          try { snapshot(); } catch (e) {}
          step();
        }, 350);
      };
      step();
    });
  };
  var send = function (html, text) {
    try { window.__TAURI_INTERNALS__.invoke('render_result', { html: html, text: text }); } catch (e) {}
  };
  /* 播放类站点（如库街区语音）的台词在点击播放控件后才注入到
     .voice-item-content（class 含 item-content），并按条目常驻。实测（库街区）：
     1) 只有叶子图标按钮是真正的播放控件，容器/整行点击无效；
     2) 往条目里克隆的副本会被前端框架下一次渲染清掉——无需克隆，文本自己会留。
     策略：优先走 injectFromNet 接口注入（命中即跳过本遍历）；点击遍历全程静音
     （初始化脚本已在 play 事件层静音），逐条点击→轮询等新文案入账（≤1.2s），
     连续 8 条失败早退；结束后把被站点收起的文案补回原条目，立即快照。 */
  var muteAll = function () {
    try {
      var au = document.querySelectorAll('audio, video');
      for (var m = 0; m < au.length; m++) { au[m].muted = true; au[m].volume = 0; }
    } catch (e) {}
  };
  var savedTexts = {};
  var savedEntries = [];
  var saveInjections = function () {
    try {
      var nodes = document.querySelectorAll('[class*="item-content"]');
      for (var k = 0; k < nodes.length; k++) {
        var c = nodes[k];
        var text = (c.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length < 2 || savedTexts[text]) continue;
        savedTexts[text] = 1;
        savedEntries.push({ host: c.parentElement, html: c.outerHTML });
      }
    } catch (e) {}
  };
  var restoreInjections = function () {
    for (var k = 0; k < savedEntries.length; k++) {
      var e = savedEntries[k];
      try {
        if (!e.host || !e.host.isConnected) continue;
        if (e.host.querySelector('[class*="item-content"]')) continue;
        var wrap = document.createElement('div');
        wrap.innerHTML = e.html;
        e.host.appendChild(wrap.firstChild);
      } catch (err) {}
    }
  };
  var clickPlayers = function () {
    return new Promise(function (done) {
      var deadline = Date.now() + 60000;
      var players = [];
      try {
        var all = document.body
          ? document.body.querySelectorAll('[class*="player"], [class*="audio"], [class*="voice"], [class*="play"]')
          : [];
        for (var k = 0; k < all.length; k++) {
          var el = all[k];
          if (el.childElementCount !== 0) continue;
          if (/^(img|svg)$/i.test(el.tagName)) continue;
          /* 容器词类名的空叶子（如 voice-item-input-container）不是播放控件 */
          if (/(input|container|content|wrapper|panel)/i.test(el.className || '')) continue;
          var t3 = (el.textContent || '').trim();
          if (t3.length > 4) continue;
          if (!el.getClientRects || !el.getClientRects().length) continue;
          /* 语音/音频祖先内的叶子优先（库街区真正的按钮是 .ico-voice-btn，
             整行/容器点击无效），其余媒体叶子兜底 */
          var inMedia = el.closest('[class*="voice"], [class*="audio"], [class*="player"], [class*="play"]');
          players.push({ el: el, pri: (inMedia ? 0 : 2) + (t3.length === 0 ? 0 : 1) });
        }
      } catch (e) {}
      players.sort(function (a, b) { return a.pri - b.pri; });
      players = players.slice(0, 80);
      var idx = 0, misses = 0;
      var step = function () {
        if (idx >= players.length || Date.now() > deadline || misses >= 8) {
          saveInjections();
          restoreInjections();
          snapshot();
          done(); return;
        }
        var before = savedEntries.length;
        try { players[idx].el.click(); } catch (e) {}
        idx++;
        var waited = 0;
        var poll = function () {
          saveInjections();
          if (savedEntries.length > before) {
            /* 文本已出现：静掉这条的余音，稍候点下一条 */
            misses = 0;
            muteAll();
            setTimeout(step, 500);
            return;
          }
          waited += 100;
          if (waited < 1200 && Date.now() <= deadline) { setTimeout(poll, 100); return; }
          misses++;
          muteAll();
          setTimeout(step, 400);
        };
        poll();
      };
      step();
    });
  };
  /* 第三层兜底：读取初始化脚本录制的接口响应（window.__HEID_NET__），
     在 JSON（含嵌套 JSON 字符串）里按「字符串值恰好等于 DOM 条目标题 →
     同对象内最长的其他字符串作为内容」配对，把台词直接注入条目 DOM。
     标题采集限定在类名含 voice/audio 的子树内，避免误配正文短语。
     返回成功注入的条数。 */
  var injectFromNet = function () {
    var stash = window.__HEID_NET__;
    if (!stash || !stash.length) return 0;
    var titles = {};
    var norm = function (s) { return String(s).replace(/\s+/g, ''); };
    try {
      var scope = document.body.querySelectorAll('[class*="voice"] *, [class*="audio"] *');
      for (var k = 0; k < scope.length; k++) {
        var el = scope[k];
        if (el.childElementCount !== 0) continue;
        var t = (el.textContent || '').trim();
        if (t.length < 2 || t.length > 20) continue;
        var nt = norm(t);
        if (!titles[nt]) titles[nt] = { el: el, text: t };
      }
    } catch (e) { return 0; }
    var titleKeys = Object.keys(titles);
    if (!titleKeys.length) return 0;
    var found = {};
    var seen = 0;
    var walk = function (node, depth) {
      if (seen > 2000000 || depth > 24) return;
      if (typeof node === 'string') {
        if (node.length > 2 && node.length < 12582912 && (node.charAt(0) === '{' || node.charAt(0) === '[')) {
          try { walk(JSON.parse(node), depth + 1); } catch (e) {}
        }
        return;
      }
      if (!node || typeof node !== 'object') return;
      seen++;
      var strs = [];
      for (var key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        var v = node[key];
        if (typeof v === 'string') strs.push(v);
        else if (v && typeof v === 'object') walk(v, depth + 1);
      }
      for (var i = 0; i < strs.length; i++) {
        var s = strs[i];
        /* 字段值本身可能是嵌套 JSON 字符串（如库街区 data.content 组件树） */
        if (s.length > 2 && s.length < 12582912 && (s.charAt(0) === '{' || s.charAt(0) === '[')) {
          try { walk(JSON.parse(s), depth + 1); } catch (e) {}
        }
        var bucket = titles[norm(s)];
        if (!bucket || found[bucket.text]) continue;
        var best = '';
        for (var j = 0; j < strs.length; j++) {
          if (j !== i && strs[j].length > best.length && strs[j].length >= 8 && strs[j].length <= 2000) best = strs[j];
        }
        if (best) found[bucket.text] = best;
      }
    };
    for (var n = 0; n < stash.length; n++) {
      try { walk(JSON.parse(stash[n].body), 0); } catch (e) {}
    }
    /* 原文兜底：JSON 解析失败（如响应被截断）时，直接在原文里找标题，
       其后取最长 CJK 连续段作为台词（转义包裹的值也能命中） */
    for (var tk = 0; tk < titleKeys.length; tk++) {
      var text = titles[titleKeys[tk]].text;
      if (found[text]) continue;
      var hit = null;
      for (var n2 = 0; n2 < stash.length && !hit; n2++) {
        var at = stash[n2].body.indexOf(text);
        if (at >= 0) hit = { body: stash[n2].body, at: at };
      }
      if (!hit) continue;
      var seg = hit.body.substr(hit.at + text.length, 900);
      var cjk = seg.match(/[\u3400-\u9fff][\u3400-\u9fff\u3040-\u30ff\uf900-\ufaff\uff00-\uffef，。！？…、：；""''（）\sA-Za-z0-9%~％+*/·—-]{7,}/);
      if (cjk && cjk[0].length >= 8) {
        found[text] = cjk[0].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\s+$/, '');
      }
    }
    var injected = 0;
    for (var title in found) {
      try {
        if (!Object.prototype.hasOwnProperty.call(found, title)) continue;
        var el2 = titles[norm(title)].el;
        var root = el2;
        for (var u = 0; u < 5 && root; u++) {
          if (/(item|row|list|card)/i.test(String(root.className || ''))) break;
          root = root.parentElement;
        }
        var target = root || el2.parentElement;
        if (!target || target.querySelector('[class*="item-content"]')) continue;
        var div = document.createElement('div');
        div.className = 'voice-item-content';
        div.textContent = found[title];
        target.appendChild(div);
        injected++;
      } catch (e) {}
    }
    return injected;
  };
  var run = async function () {
    await stable(5, 24, 500);
    snapshot();
    await clickThrough();
    await stable(3, 10, 400);
    snapshot();
    var injected = 0;
    try { injected = injectFromNet(); } catch (e) {}
    if (injected === 0) {
      await clickPlayers();
    }
    await stable(2, 8, 400);
    snapshot();
    send(best ? best.html : '', best ? best.text : '');
  };
  run();
})()"#;

/// 等待中的渲染结果回传通道（render_result 按窗口标签查表投递）
fn pending() -> &'static Mutex<HashMap<String, Sender<Result<(String, String), String>>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Sender<Result<(String, String), String>>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn destroy_scraper_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(SCRAPER_LABEL) {
        let _ = w.destroy();
    }
}

/// 渲染指定 URL 并返回 (最终 URL, 渲染后的 HTML, 页面可见文本)
#[tauri::command]
pub async fn render_page(app: tauri::AppHandle, url: String) -> Result<(String, String, String), String> {
    validate_url(&url)?;
    let parsed: tauri::Url = url.trim().parse().map_err(|e| format!("URL 解析失败：{e}"))?;

    destroy_scraper_window(&app);

    let (tx, rx) = std::sync::mpsc::channel::<Result<(String, String), String>>();
    pending()
        .lock()
        .unwrap()
        .insert(SCRAPER_LABEL.to_string(), tx.clone());

    /* 最终 URL 跟踪重定向（图片相对地址按它补全） */
    let final_url = Arc::new(Mutex::new(parsed.clone()));

    let app_for_build = app.clone();
    let url_for_build = parsed.clone();
    let final_url_for_build = final_url.clone();
    let app_for_run = app_for_build.clone();
    let build_result = {
        app_for_run
            .run_on_main_thread(move || {
                let final_url_cb = final_url_for_build.clone();
                let built = tauri::webview::WebviewWindowBuilder::new(
                    &app_for_build,
                    SCRAPER_LABEL,
                    tauri::WebviewUrl::External(url_for_build.clone()),
                )
                .title("H.E.I.D 渲染抓取")
                .visible(false)
                .skip_taskbar(true)
                .focused(false)
                .initialization_script(INIT_JS)
                .on_navigation(move |u| {
                    if let Ok(mut f) = final_url_cb.lock() {
                        *f = u.clone();
                    }
                    true
                })
                .on_page_load(|window, payload| {
                    if payload.event() == tauri::webview::PageLoadEvent::Finished {
                        let _ = window.eval(SETTLE_JS);
                    }
                })
                .build();
                if let Err(e) = built {
                    if let Some(tx) = pending().lock().unwrap().remove(SCRAPER_LABEL) {
                        let _ = tx.send(Err(format!("创建渲染窗口失败：{e}")));
                    }
                }
            })
            .map_err(|e| {
                if let Some(tx) = pending().lock().unwrap().remove(SCRAPER_LABEL) {
                    let _ = tx.send(Err(format!("调度渲染窗口失败：{e}")));
                }
                e.to_string()
            })
            .map(|_| ())
    };

    if let Err(e) = build_result {
        destroy_scraper_window(&app);
        return Err(e);
    }

    /* 等待页面回传（阻塞线程池线程，不卡主线程事件循环） */
    let waited = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(RENDER_TIMEOUT))
        .await
        .map_err(|e| format!("渲染等待中断：{e}"))?;

    pending().lock().unwrap().remove(SCRAPER_LABEL);
    destroy_scraper_window(&app);

    let (html, text) = match waited {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("渲染超时：页面加载未在限时内完成".into()),
    };
    if html.len() > MAX_HTML_BYTES {
        return Err("渲染结果超过大小上限".into());
    }
    let final_url = final_url.lock().map(|f| f.to_string()).unwrap_or_default();
    Ok((final_url, html, text))
}

/// 页面回传渲染结果（仅 heid-scraper 窗口被授权调用；转发给等待中的 render_page）
#[tauri::command]
pub fn render_result(window: tauri::Window, html: String, text: String) -> Result<(), String> {
    if window.label() != SCRAPER_LABEL {
        return Ok(());
    }
    let sender = pending().lock().unwrap().get(SCRAPER_LABEL).cloned();
    if let Some(tx) = sender {
        let _ = tx.send(Ok((html, text)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn settle_js_is_self_guarded() {
        // 注入脚本必须自带重入保护与回传调用，避免多次 page-load 重复发送
        assert!(super::SETTLE_JS.contains("__HEID_SETTLE__"));
        assert!(super::SETTLE_JS.contains("render_result"));
        assert!(super::SETTLE_JS.contains("outerHTML"));
        // 播放遍历必须只点叶子控件（容器点击无效）并在收尾补回被收起的文案
        assert!(super::SETTLE_JS.contains("childElementCount"));
        assert!(super::SETTLE_JS.contains("restoreInjections"));
        // 接口录制兜底：读到录制响应即可注入台词并跳过播放遍历；
        // 原文兜底负责 JSON 解析失败（截断响应）时的台词配对
        assert!(super::SETTLE_JS.contains("__HEID_NET__"));
        assert!(super::SETTLE_JS.contains("injectFromNet"));
        assert!(super::SETTLE_JS.contains("body.indexOf(text)"));
    }

    #[test]
    fn init_js_records_responses() {
        // 初始化脚本必须在文档启动前包好 fetch/XHR，且自带重入保护；
        // 并在播放事件层全程静音（抓取不该出声）
        assert!(super::INIT_JS.contains("__HEID_NET_INIT__"));
        assert!(super::INIT_JS.contains("origFetch.apply"));
        assert!(super::INIT_JS.contains("XMLHttpRequest"));
        assert!(super::INIT_JS.contains("responseText"));
        assert!(super::INIT_JS.contains("addEventListener('play'"));
        assert!(super::INIT_JS.contains("muted = true"));
    }
}
