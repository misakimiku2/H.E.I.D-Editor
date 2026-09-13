package com.nexus.editor

import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
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

  /** 安全区（状态栏/手势条高度），CSS px */
  @Volatile private var cssTop = 0
  @Volatile private var cssBottom = 0

  private lateinit var openDocLauncher: ActivityResultLauncher<Intent>
  private lateinit var createDocLauncher: ActivityResultLauncher<Intent>
  private lateinit var openTreeLauncher: ActivityResultLauncher<Intent>

  /** 前端桥：安全区 / SAF 文件访问（读写 content URI） */
  private inner class InsetBridge {
    @JavascriptInterface
    fun top(): Int = cssTop

    @JavascriptInterface
    fun bottom(): Int = cssBottom

    /** SAF content URI → 显示文件名（数字型 URI 前端无法自行解析） */
    @JavascriptInterface
    fun displayName(uri: String): String? = queryDisplayName(Uri.parse(uri))

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
  }

    /* uiMode 在 configChanges 中：系统深浅色切换不重建 Activity，WebView 的
       prefers-color-scheme 也不会更新——此处捕获变化推给前端 */
    override fun onConfigurationChanged(newConfig: Configuration) {
      super.onConfigurationChanged(newConfig)
      val dark = (newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
      evalJs("window.dispatchEvent(new CustomEvent('heid-sysdark',{detail:{dark:$dark}}))")
    }

  override fun onWebViewCreate(webView: WebView) {
    webViewRef = webView
    webView.addJavascriptInterface(InsetBridge(), "HeidBridge")
    val density = resources.displayMetrics.density
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      cssTop = Math.round(bars.top / density)
      cssBottom = Math.round(bars.bottom / density)
      webView.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('heid-insets',{detail:{top:$cssTop,bottom:$cssBottom}}))",
        null
      )
      insets
    }
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
