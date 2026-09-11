package com.nexus.editor

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray

class MainActivity : TauriActivity() {
  private var webViewRef: WebView? = null

  /** 安全区（状态栏/手势条高度），CSS px */
  @Volatile private var cssTop = 0
  @Volatile private var cssBottom = 0

  private lateinit var openDocLauncher: ActivityResultLauncher<Intent>
  private lateinit var createDocLauncher: ActivityResultLauncher<Intent>

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

    /** 对 content URI 覆写内容（SAF 写授权在前端打开时持久化） */
    @JavascriptInterface
    fun writeBase64(uri: String, dataBase64: String): Boolean = try {
      contentResolver.openOutputStream(Uri.parse(uri), "wt")?.use { os ->
        os.write(Base64.decode(dataBase64, Base64.NO_WRAP))
        os.flush()
        true
      } ?: false
    } catch (e: Exception) {
      false
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
