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
/// 渲染等待总超时：初始稳定 ~12s + 点击遍历 8s + 二次稳定 4s + 网络余量
const RENDER_TIMEOUT: Duration = Duration::from_secs(42);
/// 回传 HTML 大小上限（16MB）
const MAX_HTML_BYTES: usize = 16 * 1024 * 1024;

/// 页面内注入的稳定检测 + 懒加载展开脚本：
/// 1) DOM 长度连续 5×500ms 不变即视为初始渲染完成（24 次轮询硬上限）；
/// 2) 点击遍历短文本叶子元素，展开游戏 wiki 常见的「点击后才加载」的面板
///    （语音/技能/天赋等）。关键词命中者优先；误触 SPA 路由时用 history.back()
///    恢复后继续；每次点击后快照，最终取可见文本最长的一份回传。
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
  /* 播放类站点（如库街区语音）的文案在点击播放后才注入且逐条替换，
     每次点击后把出现的文案克隆保存进所属条目，最终 DOM 即含全部文本 */
  var saveInjections = function () {
    var nodes = document.querySelectorAll('[class*="item-content"]');
    for (var k = 0; k < nodes.length; k++) {
      var c = nodes[k];
      if (c.getAttribute('data-heid-saved')) continue;
      var host = c.parentElement;
      if (!host) continue;
      c.setAttribute('data-heid-saved', '1');
      var clone = c.cloneNode(true);
      clone.setAttribute('data-heid-saved', '1');
      host.appendChild(clone);
    }
  };
  var clickPlayers = function () {
    return new Promise(function (done) {
      var deadline = Date.now() + 10000;
      var players = [];
      try {
        var all = document.body ? document.body.querySelectorAll('[class*="player"], [class*="audio"]') : [];
        for (var k = 0; k < all.length; k++) {
          if (!all[k].offsetParent) continue;
          players.push(all[k]);
        }
      } catch (e) {}
      players = players.slice(0, 20);
      var idx = 0;
      var step = function () {
        if (idx >= players.length || Date.now() > deadline) { saveInjections(); done(); return; }
        try { players[idx].click(); } catch (e) {}
        idx++;
        setTimeout(function () { try { saveInjections(); } catch (e) {} step(); }, 500);
      };
      step();
    });
  };
  var run = async function () {
    await stable(5, 24, 500);
    snapshot();
    await clickThrough();
    await stable(3, 10, 400);
    snapshot();
    await clickPlayers();
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
    }
}
