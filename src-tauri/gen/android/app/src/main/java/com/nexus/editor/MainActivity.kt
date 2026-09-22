package com.nexus.editor

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.hardware.input.InputManager
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import java.nio.charset.Charset

class MainActivity : TauriActivity() {
  private var webViewRef: WebView? = null

  /** 安全区（状态栏/手势条高度）与键盘高度，CSS px */
  @Volatile private var cssTop = 0
  @Volatile private var cssBottom = 0
  @Volatile private var cssKb = 0

  private lateinit var openDocLauncher: ActivityResultLauncher<Intent>
  private lateinit var createDocLauncher: ActivityResultLauncher<Intent>
  private lateinit var openTreeLauncher: ActivityResultLauncher<Intent>

  /** 物理键盘接入状态监听（前端快捷键提示仅接入时显示）；上次推送值用于去重 */
  private var inputDeviceListener: InputManager.InputDeviceListener? = null
  @Volatile private var lastPushedHwKb: Boolean? = null

  /** 是否接有物理键盘：枚举输入设备里的非虚拟「全键盘」（键位表 FULL）。
      外置键盘/键盘盖是 FULL；软键盘 isVirtual、电源键等 gpio-keys 内置按键的
      键位表是 SPECIAL_FUNCTION，均排除——只按 KEYBOARD source 判会在几乎
      所有真机上被电源键设备误报为已接入 */
  private fun hasHardwareKeyboard(): Boolean {
    val im = getSystemService(Context.INPUT_SERVICE) as? InputManager ?: return false
    for (id in im.inputDeviceIds) {
      val dev = im.getInputDevice(id) ?: continue
      if (dev.isVirtual || (dev.sources and InputDevice.SOURCE_KEYBOARD) == 0) continue
      val kcm = try { dev.keyCharacterMap } catch (_: Exception) { continue }
      if (kcm.keyboardType == KeyCharacterMap.FULL) return true
    }
    return false
  }

  /** 接入状态变化推给前端（值未变化时跳过，dispatchKeyEvent 高频调用靠它去重） */
  private fun pushHardwareKeyboard() {
    val has = hasHardwareKeyboard()
    if (lastPushedHwKb == has) return
    lastPushedHwKb = has
    evalJs("window.dispatchEvent(new CustomEvent('heid-hwkb',{detail:$has}))")
  }

  /** 前端桥：安全区 / SAF 文件访问（读写 content URI） */
  private inner class InsetBridge {
    @JavascriptInterface
    fun top(): Int = cssTop

    @JavascriptInterface
    fun bottom(): Int = cssBottom

    /** 软键盘高度（已扣除手势条；0 = 键盘收起） */
    @JavascriptInterface
    fun kb(): Int = cssKb

    /** SAF content URI → 显示文件名（数字型 URI 前端无法自行解析） */
    @JavascriptInterface
    fun displayName(uri: String): String? = queryDisplayName(Uri.parse(uri))

    /** 取走并清空外部应用送来的内容（JSON 数组，元素为 {uri,name} 或 {text}；无则 "[]"）。
        冷启动时页面还没加载完、事件会丢，故队列是唯一事实源，前端就绪后主动来取 */
    @JavascriptInterface
    fun takeLaunchFiles(): String = synchronized(launchFiles) {
      val json = if (launchFiles.isEmpty()) "[]" else "[${launchFiles.joinToString(",")}]"
      launchFiles.clear()
      json
    }

    /** 系统文档选择器（支持多选）。结果经 heid-saf 事件回传。 */
    @JavascriptInterface
    fun openDocs(mimesJson: String) {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "*/*"
        putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        val mimes = parseMimes(mimesJson)
        if (mimes.isNotEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, mimes)
      }
      openDocLauncher.launch(intent)
    }

    /** 系统新建文档（另存为）。结果经 heid-saf 事件回传。 */
    @JavascriptInterface
    fun createDoc(name: String, mime: String) {
      val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = mime.ifBlank { "text/plain" }
        putExtra(Intent.EXTRA_TITLE, name)
      }
      createDocLauncher.launch(intent)
    }

    /** 对 content URI 覆写内容（SAF 写授权在前端打开时持久化）。
        content 为 JS 侧字符串，此处按 encoding label 编码为字节，支持 UTF-8 以外的编码写盘。 */
    @JavascriptInterface
    fun writeUri(uri: String, content: String, encoding: String, bom: Boolean): Boolean = try {
      val charset = charsetFor(encoding)
      var bytes = content.toByteArray(charset)
      if (bom) {
        val prefix: ByteArray = when (encoding.lowercase()) {
          "utf-8" -> byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())
          "utf-16le" -> byteArrayOf(0xFF.toByte(), 0xFE.toByte())
          "utf-16be" -> byteArrayOf(0xFE.toByte(), 0xFF.toByte())
          else -> ByteArray(0)
        }
        if (prefix.isNotEmpty() && !(bytes.size >= prefix.size && prefix.indices.all { bytes[it] == prefix[it] })) {
          bytes = prefix + bytes
        }
      }
      contentResolver.openOutputStream(Uri.parse(uri), "wt")?.use { os ->
        os.write(bytes)
        os.flush()
        true
      } ?: false
    } catch (e: Exception) {
      false
    }

    /** 系统目录树选择器（文件树侧栏）。结果经 heid-saf 事件回传（kind:'tree'，path=treeUri）。 */
    @JavascriptInterface
    fun openTree() {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
      openTreeLauncher.launch(intent)
    }

    /** 列出 SAF 目录子项（同步返回 JSON 数组）。
        dirPath 前端约定为 "treeUri\u0000相对路径"（根目录可只传 treeUri）；
        每项 {name,isDir,uri}，uri 为可直接读写的 document URI（文件打开用）。 */
    @JavascriptInterface
    fun listTree(treeUri: String, relPath: String): String = try {
      val root = Uri.parse(treeUri)
      val treeDocId = DocumentsContract.getTreeDocumentId(root)
      val parentDocId = if (relPath.isBlank()) treeDocId else "$treeDocId/$relPath"
      val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(root, parentDocId)
      val items = ArrayList<String>()
      contentResolver.query(
        childrenUri,
        arrayOf(
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          DocumentsContract.Document.COLUMN_MIME_TYPE
        ),
        null, null, null
      )?.use { c ->
        while (c.moveToNext()) {
          val docId = c.getString(0) ?: continue
          val name = c.getString(1) ?: continue
          val mime = c.getString(2)
          val isDir = mime == DocumentsContract.Document.MIME_TYPE_DIR
          val docUri = DocumentsContract.buildDocumentUriUsingTree(root, docId)
          items.add(
            "{\"name\":\"${jsonEscape(name)}\",\"isDir\":$isDir,\"uri\":\"${jsonEscape(docUri.toString())}\"}"
          )
        }
      }
      "[${items.joinToString(",")}]"
    } catch (e: Exception) {
      "[]"
    }

    /** SAF 树内路径约定（与前端 fileTree.ts 的 SAF_SEP 一致）：
        目录 = "treeUri\u0000相对路径"，文件 = 完整 document URI（content://…） */

    /** 拆出 treeUri 与相对路径（目录路径专用；根目录路径无分隔符 → rel 为空，与 listTree 的 JS 约定一致） */
    private fun splitTreePath(dirPath: String): Pair<Uri, String>? {
      val sepIdx = dirPath.indexOf('\u0000')
      val root = Uri.parse(if (sepIdx >= 0) dirPath.substring(0, sepIdx) else dirPath)
      val rel = if (sepIdx >= 0) dirPath.substring(sepIdx + 1) else ""
      return root to rel
    }

    /** 条目路径 → document URI：文件（content://）原样；目录按 treeUri+rel 构建 */
    private fun entryDocUri(entryPath: String): Uri? {
      if (entryPath.startsWith("content://")) return Uri.parse(entryPath)
      val (root, rel) = splitTreePath(entryPath) ?: return null
      val treeDocId = DocumentsContract.getTreeDocumentId(root)
      val docId = if (rel.isBlank()) treeDocId else "$treeDocId/$rel"
      return DocumentsContract.buildDocumentUriUsingTree(root, docId)
    }

    /** 树内新建（目录 / 空文件，v1.4 SAF 文件管理）。parentDirPath 为父目录树内路径。
        返回新建文档的 document URI，失败返回 null（前端以「提供器拒绝」提示） */
    @JavascriptInterface
    fun createInTree(parentDirPath: String, name: String, isDir: Boolean): String? {
      return try {
        val (root, rel) = splitTreePath(parentDirPath) ?: return null
        val treeDocId = DocumentsContract.getTreeDocumentId(root)
        val parentDocId = if (rel.isBlank()) treeDocId else "$treeDocId/$rel"
        val parentUri = DocumentsContract.buildDocumentUriUsingTree(root, parentDocId)
        val mime = if (isDir) DocumentsContract.Document.MIME_TYPE_DIR else mimeForName(name)
        DocumentsContract.createDocument(contentResolver, parentUri, mime, name)?.toString()
      } catch (e: Exception) {
        null
      }
    }

    /** 树内重命名（目录 / 文件；仅改名不移动）。name 为新显示名。
        返回提供器确认后的新 document URI，失败返回 null */
    @JavascriptInterface
    fun renameEntry(entryPath: String, newName: String): String? {
      return try {
        val docUri = entryDocUri(entryPath) ?: return null
        DocumentsContract.renameDocument(contentResolver, docUri, newName)?.toString()
      } catch (e: Exception) {
        null
      }
    }

    /** 树内删除（目录由文档提供器递归处理） */
    @JavascriptInterface
    fun deleteEntry(entryPath: String): Boolean {
      return try {
        val docUri = entryDocUri(entryPath) ?: return false
        DocumentsContract.deleteDocument(contentResolver, docUri)
      } catch (e: Exception) {
        false
      }
    }

    /** 扩展名 → MIME（新建文件用；未知扩展名按纯文本） */
    private fun mimeForName(name: String): String {
      val ext = name.substringAfterLast('.', "").lowercase()
      return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "text/plain"
    }

    /** WHATWG label → Charset（与前端 lib/encoding.ts 的选项一一对应） */
    private fun charsetFor(label: String): Charset = when (label.lowercase()) {
      "utf-8" -> Charsets.UTF_8
      "utf-16le" -> Charsets.UTF_16LE
      "utf-16be" -> Charsets.UTF_16BE
      "gbk" -> Charset.forName("GBK")
      "gb18030" -> Charset.forName("GB18030")
      "big5" -> Charset.forName("Big5")
      "shift_jis" -> Charset.forName("Shift_JIS")
      "windows-1252" -> Charset.forName("windows-1252")
      else -> Charsets.UTF_8
    }

    /** 系统当前是否深色（WebView prefers-color-scheme 在 configChanges 含 uiMode 时不
        随系统更新，深浅色初值与变化都走此桥） */
    @JavascriptInterface
    fun isSystemDark(): Boolean =
      (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    /** 是否接有物理键盘（初值由前端启动时补读；变化经 heid-hwkb 事件推送） */
    @JavascriptInterface
    fun hwKb(): Boolean = hasHardwareKeyboard()

    /** 状态栏/导航栏图标外观跟随应用主题（应用内切换深浅色时由 JS 调用；
        键盘自身主题无公开 API 可控，跟随系统设置） */
    @JavascriptInterface
    fun setDarkTheme(dark: Boolean) {
      runOnUiThread {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = !dark
        controller.isAppearanceLightNavigationBars = !dark
      }
    }

    /** 退出应用（window.destroy 在 Android 上不可用） */
    @JavascriptInterface
    fun exitApp() {
      runOnUiThread { finishAffinity() }
    }

    /** 外部链接交给系统浏览器打开（预览内链接不允许在应用 WebView 内导航） */
    @JavascriptInterface
    fun openUrl(url: String) {
      try {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(intent)
      } catch (_: Exception) {
      }
    }

    /** 系统分享面板（平板菜单栏「分享」，替代桌面打印）：纯文本 + 主题。
        内容超 Binder 限制时 intent 写入抛异常，前端已按字符数预拦截 */
    @JavascriptInterface
    fun shareText(title: String, content: String) {
      runOnUiThread {
        try {
          val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, title)
            putExtra(Intent.EXTRA_TEXT, content)
          }
          startActivity(Intent.createChooser(intent, title))
        } catch (_: Exception) {
        }
      }
    }

    /** 网址导入渲染兜底：离屏 WebView 加载页面，渲染稳定后经 heid-render 事件回传 HTML */
    @JavascriptInterface
    fun renderPage(url: String) {
      runOnUiThread { startOffscreenRender(url) }
    }
  }

  /** 离屏渲染 WebView（网址导入兜底专用，用后即毁） */
  private var renderWebView: WebView? = null
  @Volatile private var renderDelivered = false

  /** 注入到离屏渲染页的稳定检测 + 懒加载展开：稳定后点击短文本叶子展开懒加载面板
     （关键词优先；误触路由用 history.back 恢复），取可见文本最长快照回传 */
  private val renderSettleJs = """
    (function () {
      if (window.__HEID_SETTLE__) return;
      window.__HEID_SETTLE__ = true;
      var startHref = location.href;
      var navFlag = false;
      var bestText = null;
      try {
        var ps = history.pushState, rs = history.replaceState;
        history.pushState = function () { navFlag = true; return ps.apply(this, arguments); };
        history.replaceState = function () { navFlag = true; return rs.apply(this, arguments); };
      } catch (e) {}
      var snapshot = function () {
        var text = document.body && document.body.innerText ? document.body.innerText : '';
        if (!bestText || text.length > bestText.length) bestText = text;
      };
      var stable = function (idleNeed, tickCap, wait) {
        return new Promise(function (done) {
          var i = 0, t = 0, lastLen = -1;
          var step = function () {
            t++;
            var len = document.documentElement ? document.documentElement.outerHTML.length : 0;
            if (len === lastLen) { i++; } else { i = 0; lastLen = len; }
            if (i >= idleNeed || t >= tickCap) { done(); return; }
            setTimeout(step, wait);
          };
          step();
        });
      };
      var KEY = /(语音|voice|技能|skill|天赋|talent|战斗|battle|档案|故事|story|资料|台词|audio)/i;
      var clickThrough = function () {
        return new Promise(function (done) {
          var deadline = Date.now() + 10000;
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
        try { window.HeidRender.renderDone(html || '', text || '', window.location.href); } catch (e) {}
      };
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
        send(
          document.documentElement ? document.documentElement.outerHTML.slice(0, 8388608) : '',
          (bestText || '').slice(0, 1048576)
        );
      };
      run();
    })()
  """.trimIndent()

  private fun startOffscreenRender(url: String) {
    renderWebView?.destroy()
    renderDelivered = false
    val wv = WebView(this)
    renderWebView = wv
    wv.settings.javaScriptEnabled = true
    wv.settings.domStorageEnabled = true
    wv.addJavascriptInterface(RenderResultBridge(), "HeidRender")
    wv.webViewClient = object : android.webkit.WebViewClient() {
      override fun onPageFinished(view: WebView, url: String) {
        view.evaluateJavascript(renderSettleJs, null)
      }
    }
    /* 整体看门狗：20s 仍未回传则放弃并销毁 */
    wv.postDelayed({
      if (!renderDelivered) deliverRender("", "", url)
    }, 42000)
    wv.loadUrl(url)
  }

  private inner class RenderResultBridge {
    @JavascriptInterface
    fun renderDone(html: String, text: String, url: String) {
      runOnUiThread { deliverRender(html, text, url) }
    }
  }

  /** 只投递一次：把渲染结果以 heid-render 事件推给主 WebView，随后销毁离屏实例 */
  private fun deliverRender(html: String, text: String, url: String) {
    if (renderDelivered) return
    renderDelivered = true
    val capped = if (html.length > 8 * 1024 * 1024) html.substring(0, 8 * 1024 * 1024) else html
    val cappedText = if (text.length > 1024 * 1024) text.substring(0, 1024 * 1024) else text
    evalJs(
      "window.dispatchEvent(new CustomEvent('heid-render',{detail:{html:\"${jsonEscape(capped)}\",text:\"${jsonEscape(cappedText)}\",url:\"${jsonEscape(url)}\"}}))"
    )
    renderWebView?.destroy()
    renderWebView = null
  }

  /* ---- 外部应用送来的文件：「打开方式」(ACTION_VIEW) 与「分享」(ACTION_SEND/_MULTIPLE) ----
     manifest 的 intent-filter 只负责让应用出现在系统列表里，URI 要自己取。
     冷启动时 WebView 里的页面还没加载完、派发的事件会丢，所以收到的文件先入队：
     前端就绪后调 takeLaunchFiles() 一次取空；应用已在前台时（热启动）再催一次 heid-view。
     队列是唯一事实源、取走即清，事件只负责唤醒——重复投递不会把同一个文件打开两次。 */
  private val launchFiles = ArrayList<String>()

  /** 收下一个入向 intent 里的可打开内容并入队（无关 action、或没有能读的 URI 时什么都不做） */
  private fun collectInbound(intent: Intent?) {
    if (intent == null) return
    val items: List<String> = when (intent.action) {
      Intent.ACTION_VIEW ->
        listOfNotNull(intent.data).filter(::openable).map { launchFileForUri(it, intent.flags) }
      Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> {
        val streams = sendStreamUris(intent).filterNotNull()
          .filter(::openable).map { launchFileForUri(it, intent.flags) }
        /* 分享面板上「分享文本」没有附件、只有 EXTRA_TEXT：也接住，前端落成一个新的未命名草稿。
           不接的话我们在分享列表里出现却什么都不做——和没实现一样 */
        streams.ifEmpty { listOfNotNull(sharedTextItem(intent)) }
      }
      else -> return
    }
    if (items.isEmpty()) return
    synchronized(launchFiles) { launchFiles.addAll(items) }
    evalJs("window.dispatchEvent(new CustomEvent('heid-view'))")
  }

  /** 只接 content://（文档提供器给授权）与 file://（管理器直连自带可读）；http(s) 之类交给浏览器 */
  private fun openable(uri: Uri?): Boolean =
    uri != null && (uri.scheme == "content" || uri.scheme == "file")

  /** 文件条目：顺手持久化授权（提供器只给临时授权时抛异常，忽略即可），并解析显示名 */
  private fun launchFileForUri(uri: Uri, flags: Int): String {
    takePersistable(uri, flags)
    val name = queryDisplayName(uri) ?: ""
    return "{\"uri\":\"${jsonEscape(uri.toString())}\",\"name\":\"${jsonEscape(name)}\"}"
  }

  private fun sharedTextItem(intent: Intent): String? {
    val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()
    return if (text.isNullOrEmpty()) null else "{\"text\":\"${jsonEscape(text)}\"}"
  }

  /** 分享送来的附件在 EXTRA_STREAM：单个 Uri 或 Uri 列表（SEND_MULTIPLE） */
  private fun sendStreamUris(intent: Intent): List<Uri?> = try {
    when (val raw = intent.extras?.get(Intent.EXTRA_STREAM)) {
      is ArrayList<*> -> raw.filterIsInstance<Uri>()
      is Uri -> listOf(raw)
      else -> emptyList()
    }
  } catch (_: Exception) {
    emptyList()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    openDocLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
      val files = ArrayList<String>()
      val data = res.data
      if (res.resultCode == Activity.RESULT_OK && data != null) {
        fun handle(uri: Uri) {
          takePersistable(uri, data.flags)
          val name = queryDisplayName(uri) ?: ""
          files.add("{\"uri\":\"${jsonEscape(uri.toString())}\",\"name\":\"${jsonEscape(name)}\"}")
        }
        val clip = data.clipData
        if (clip != null) {
          for (i in 0 until clip.itemCount) handle(clip.getItemAt(i).uri)
        } else {
          data.data?.let { handle(it) }
        }
      }
      evalJs(
        "window.dispatchEvent(new CustomEvent('heid-saf',{detail:{kind:'open'," +
          "canceled:${files.isEmpty()},files:[${files.joinToString(",")}]}}))"
      )
    }

    openTreeLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
      val uri = if (res.resultCode == Activity.RESULT_OK) res.data?.data else null
      if (uri != null && res.data != null) takePersistable(uri, res.data!!.flags)
      val pathJson = if (uri != null) "\"" + jsonEscape(uri.toString()) + "\"" else "null"
      evalJs(
        "window.dispatchEvent(new CustomEvent('heid-saf',{detail:{kind:'tree'," +
          "canceled:${uri == null},path:$pathJson}}))"
      )
    }

    createDocLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
      val uri = if (res.resultCode == Activity.RESULT_OK) res.data?.data else null
      if (uri != null && res.data != null) takePersistable(uri, res.data!!.flags)
      val fileJson = if (uri != null) {
        val name = queryDisplayName(uri) ?: ""
        "{\"uri\":\"${jsonEscape(uri.toString())}\",\"name\":\"${jsonEscape(name)}\"}"
      } else "null"
      evalJs(
        "window.dispatchEvent(new CustomEvent('heid-saf',{detail:{kind:'create'," +
          "canceled:${uri == null},file:$fileJson}}))"
      )
    }

    /* 系统返回键交给前端：逐层关闭弹层，最后由前端走未保存退出确认
       （WryActivity 默认行为会绕过确认直接退出，必须拦截） */
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webViewRef?.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('heid-back'))", null
        )
      }
    })

    /* 外部文件打开：冷启动读 launch intent；应用已在前台时由新 intent 触发。
       热启动不能靠覆写 onNewIntent——生成的 TauriActivity.onNewIntent 是 final 的，
       改挂 androidx 的监听器（链上各级都调了 super，回调一定会到） */
    addOnNewIntentListener { collectInbound(it) }
    collectInbound(intent)
  }

    /* uiMode 在 configChanges 中：系统深浅色切换不重建 Activity，WebView 的
       prefers-color-scheme 也不会更新——此处捕获变化推给前端 */
    override fun onConfigurationChanged(newConfig: Configuration) {
      super.onConfigurationChanged(newConfig)
      val dark = (newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
      evalJs("window.dispatchEvent(new CustomEvent('heid-sysdark',{detail:{dark:$dark}}))")
      /* 键盘接入/拔出会切换 keyboard 配置项（NOKEYS↔QWERTY），顺带重推 */
      pushHardwareKeyboard()
    }

  override fun onWebViewCreate(webView: WebView) {
    webViewRef = webView
    webView.addJavascriptInterface(InsetBridge(), "HeidBridge")
    /* 物理键盘接入监听：外接键盘/键盘盖插拔时推给前端（初始值由 HeidBridge.hwKb()
       在前端启动时补读，此处不再推——页面尚未就绪，事件会丢） */
    (getSystemService(Context.INPUT_SERVICE) as? InputManager)?.let { im ->
      val listener = object : InputManager.InputDeviceListener {
        override fun onInputDeviceAdded(deviceId: Int) { pushHardwareKeyboard() }
        override fun onInputDeviceRemoved(deviceId: Int) { pushHardwareKeyboard() }
        override fun onInputDeviceChanged(deviceId: Int) { pushHardwareKeyboard() }
      }
      inputDeviceListener = listener
      im.registerInputDeviceListener(listener, null)
    }
    val density = resources.displayMetrics.density
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      cssTop = Math.round(bars.top / density)
      cssBottom = Math.round(bars.bottom / density)
      /* 键盘高度 = IME 底边（从窗口最底量到键盘上沿，已含手势条区域，
         不可再扣 cssBottom——少一段就表现为信息栏被键盘盖住一截）。
         前端据此给根容器让位，使信息栏始终贴住键盘上沿，光标不被遮挡 */
      cssKb = Math.round(ime.bottom / density)
      webView.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('heid-insets',{detail:{top:$cssTop,bottom:$cssBottom,kb:$cssKb}}))",
        null
      )
      insets
    }
  }

  /** 回前台时重推一次：后台期间键盘插拔的事件可能丢失（去重后只补差异） */
  override fun onResume() {
    super.onResume()
    pushHardwareKeyboard()
  }

  /** 物理键盘按键必经此处（软键盘走 IME InputConnection，不进 Activity 分发）：
      设备枚举万一漏报，敲任意键也会点亮/校正提示 */
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    pushHardwareKeyboard()
    return super.dispatchKeyEvent(event)
  }

  override fun onDestroy() {
    inputDeviceListener?.let { l ->
      (getSystemService(Context.INPUT_SERVICE) as? InputManager)?.unregisterInputDeviceListener(l)
    }
    inputDeviceListener = null
    super.onDestroy()
  }

  private fun evalJs(script: String) {
    webViewRef?.evaluateJavascript(script, null)
  }

  /** 持久化读写授权，保证保存与跨重启会话恢复可用 */
  private fun takePersistable(uri: Uri, flags: Int) {
    try {
      contentResolver.takePersistableUriPermission(
        uri,
        flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      )
    } catch (_: Exception) {
    }
  }

  private fun queryDisplayName(uri: Uri): String? = try {
    contentResolver.query(
      uri,
      arrayOf(OpenableColumns.DISPLAY_NAME),
      null, null, null
    )?.use { c ->
      if (c.moveToFirst()) c.getString(0) else null
    }
  } catch (e: Exception) {
    null
  }

  private fun jsonEscape(s: String): String =
    s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r")

  private fun parseMimes(mimesJson: String): Array<String> = try {
    val arr = JSONArray(mimesJson)
    Array(arr.length()) { i -> arr.getString(i) }
  } catch (e: Exception) {
    arrayOf()
  }
}
